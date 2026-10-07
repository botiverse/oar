import type { AuthStatus, LogoutResult } from "../contracts/login.js";
import { errorMessage, LoginSecrets, loginBounds, spawnLoginProcess, type LoginProcess, type LoginProcessExit } from "./login.js";

/*
 * Mechanisms every logout driver shares: running the runtime's own logout
 * command as a login runs (its own process group, nothing it prints
 * forwarded), and the rule that the runtime's status query decides.
 */

/** How the runtime's own logout ended, before its status is read. */
export type NativeLogout =
  /** The runtime reported success: an exit 0, a call that resolved. */
  | { readonly kind: "done" }
  /** It ran, but failed or did not finish; reported as it is unless the status reads logged out. */
  | { readonly kind: "failed"; readonly reason: "timed_out" | "rejected" | "process_failed"; readonly detail: string };

export type LogoutCommandEnd =
  /** `stderr`: its last lines, escapes stripped, where a logout command reports a failure. */
  | { readonly kind: "exit"; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly stderr: readonly string[] }
  | { readonly kind: "timed_out" }
  /** The command could not start: nothing ran, so no status is read. */
  | { readonly kind: "not_started"; readonly detail: string };

const KEPT_LINES = 20;

function ended(exit: LoginProcessExit, stderr: readonly string[]): LogoutCommandEnd {
  return exit.error === undefined
    ? { kind: "exit", exitCode: exit.exitCode, signal: exit.signal, stderr }
    : { kind: "not_started", detail: new LoginSecrets().line(exit.error) };
}

/** The started command, or why it could not start (an invalid path on Windows throws). */
function spawned(command: string, args: readonly string[], env: NodeJS.ProcessEnv, onStderr: (line: string) => void): LoginProcess | Extract<LogoutCommandEnd, { kind: "not_started" }> {
  try {
    return spawnLoginProcess(command, args, env, {
      onLine(line, stream) {
        if (stream === "stderr") {
          onStderr(line);
        }
      },
    });
  } catch (error) {
    return { kind: "not_started", detail: new LoginSecrets().line(errorMessage(error)) };
  }
}

/**
 * Runs a logout command over pipes with its stdin closed, in its own process
 * group on POSIX; nothing it prints is logged or forwarded. Past `timeoutMs`
 * it is stopped with everything it started (its group, its tree on Windows).
 */
export async function runLogoutCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<LogoutCommandEnd> {
  const stderr: string[] = [];
  const child = spawned(command, args, env, (line) => {
    stderr.push(line);
    stderr.splice(0, stderr.length - KEPT_LINES);
  });
  if (!("exited" in child)) {
    return child;
  }
  // A logout reads nothing: nothing it could wait for stays open.
  child.closeInput();
  const bounds = loginBounds(undefined, timeoutMs);
  try {
    const ending = await Promise.race([
      child.exited,
      // oxlint-disable-next-line promise/prefer-await-to-then -- the deadline races the exit
      bounds.stopped.then((): "timed_out" => "timed_out"),
    ]);
    if (ending !== "timed_out") {
      return ended(ending, stderr);
    }
    child.stop();
    await child.exited;
    return { kind: "timed_out" };
  } finally {
    bounds.dispose();
  }
}

/** A logout that did not finish within the deadline. */
export function logoutTimedOut(command: string, timeoutMs: number): NativeLogout {
  return { kind: "failed", reason: "timed_out", detail: `${command} did not finish within ${String(timeoutMs)} ms` };
}

/**
 * A logout command's end: exit 0 is the runtime's success. Exit 1 with a
 * stderr line is its reported failure, in its words (the capture of
 * `failure` when a line matches it, else its last stderr line); any other
 * end is `process_failed`.
 */
export function commandLogout(end: Exclude<LogoutCommandEnd, { kind: "not_started" }>, command: string, timeoutMs: number, failure?: RegExp): NativeLogout {
  if (end.kind === "timed_out") {
    return logoutTimedOut(command, timeoutMs);
  }
  if (end.exitCode === 0) {
    return { kind: "done" };
  }
  const secrets = new LoginSecrets();
  const { stderr } = end;
  const reported = failure === undefined ? undefined : stderr.map((line) => failure.exec(line)?.[1]).findLast((message) => message !== undefined);
  const words = reported ?? stderr.at(-1);
  if (end.exitCode === 1 && words !== undefined) {
    return { kind: "failed", reason: "rejected", detail: secrets.line(words) };
  }
  const how = end.exitCode === null ? `signal ${end.signal ?? "unknown"}` : `code ${String(end.exitCode)}`;
  return { kind: "failed", reason: "process_failed", detail: words === undefined ? `${command} exited with ${how}` : secrets.line(words) };
}

/** What a logged-in status names: the method and the email, then `notes` (claude's API key source). */
function readsAs(status: Extract<AuthStatus, { kind: "logged_in" }>, notes: readonly string[]): string {
  const words = [status.account?.method, status.account?.email, ...notes].filter((word) => word !== undefined);
  return words.length === 0 ? "" : ` (${words.join(", ")})`;
}

/**
 * The status read after the runtime's logout ran decides: logged out is
 * `logged_out`, whatever the logout answered. Otherwise a failed logout is
 * its own failure, and one that succeeded is `still_logged_in` (the status
 * reads logged in: credentials from the environment or another source) or
 * `process_failed` (the status gave no answer); never `logged_out`.
 */
export function confirmedLogout(native: NativeLogout, status: AuthStatus, command: string, notes: readonly string[] = []): LogoutResult {
  if (status.kind === "logged_out") {
    return { kind: "logged_out" };
  }
  if (native.kind === "failed") {
    return { kind: "failed", reason: native.reason, detail: native.detail };
  }
  const secrets = new LoginSecrets();
  if (status.kind === "logged_in") {
    return {
      kind: "failed",
      reason: "still_logged_in",
      detail: secrets.redact(`${command} succeeded, yet ${status.source} still reads logged in${readsAs(status, notes)}`),
    };
  }
  return {
    kind: "failed",
    reason: "process_failed",
    detail: secrets.redact(`${command} succeeded, yet ${status.source ?? "its status query"} gave no answer${status.detail === undefined ? "" : `: ${status.detail}`}`),
  };
}
