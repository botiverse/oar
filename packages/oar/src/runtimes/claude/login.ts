import type { AvailableInstallation } from "../../contracts/installation.js";
import type { LoginOptions, LoginResult } from "../../contracts/login.js";
import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import {
  errorMessage,
  LoginSecrets,
  loginBounds,
  loginExecutable,
  spawnLoginProcess,
  stoppedResult,
  type LoginProcess,
  type LoginProcessExit,
  type LoginStop,
} from "../../shared/login.js";
import { claudeAuthStatus } from "./auth-status.js";
import { claudeEnv } from "./environment.js";

export { claudeAuthStatus } from "./auth-status.js";

/*
 * `claude auth login` over pipes (2.1.288). It prints, on stdout:
 *
 *   Opening browser to sign in…
 *   If the browser didn't open, visit: <url>      (an OSC 8 hyperlink from 2.1.202)
 *   Paste code here if prompted >                 (no newline)
 *
 * and races two ends: the browser's redirect to its localhost listener, and a
 * `code#state` line on stdin, which the page behind <url> shows after the
 * sign-in. A malformed line prints `Invalid code. Please make sure the full
 * code was copied.` to stderr and reading goes on. It ends with
 * `Login successful.` (exit 0, after a few seconds of telemetry flushing) or
 * a failure on stderr (exit 1): `Login failed: <message>`, or a message of
 * its own (a suspended account, an organization or provider that disallows
 * the login). It has no deadline of its own. Reading a pasted code arrived in
 * 2.1.126; `auth login` itself in 2.1.41.
 */
const PASTE_FLOOR = "2.1.126";
const LOGIN_TIMEOUT_MS = 15 * 60_000;

const URL_LINE = /If the browser didn't open, visit:\s*(\S+)/u;
const PASTE_PROMPT = /Paste code here if prompted\s*>/u;
/** At the start of a stderr line only: `Login failed: Invalid code verifier` is a failure, not a retry. */
const INVALID_CODE = /^Invalid code\b/u;
const SUCCESS = /Login successful\b/u;
const FAILURE = /Login failed:\s*(.*)$/u;

type Ending =
  | { readonly kind: "exit"; readonly exit: LoginProcessExit }
  | { readonly kind: "stop"; readonly stop: LoginStop }
  /** The caller's `prompt` or `onEvent` threw. */
  | { readonly kind: "interaction_failed"; readonly message: string };

interface FlowState {
  urlSent: boolean;
  /** The paste prompt was seen and the caller asked once; later asks follow an `Invalid code`. */
  pasteOffered: boolean;
  /** One question to the caller at a time. */
  promptOpen: boolean;
  /** The login has ended; a late answer is dropped, never written. */
  settled: boolean;
  /** claude printed `Login successful.`: the new login is stored, whatever ends the process. */
  reportedSuccess: boolean;
  /** The message of a `Login failed:` line. */
  failure: string | undefined;
  /** The last stderr line, claude's reason when it fails in words of its own. */
  lastStderr: string | undefined;
}

/**
 * The status decides once claude has exited 0 or reported success. A query
 * that cannot answer (it failed, or the caller aborted) leaves claude's own
 * report: a success it printed is `logged_in`, an exit 0 without one is not.
 */
async function confirmed(installation: AvailableInstallation, signal: AbortSignal | undefined, reportedSuccess: boolean): Promise<LoginResult> {
  const status = signal?.aborted === true
    ? undefined
    : await claudeAuthStatus(installation, signal === undefined ? {} : { signal });
  if (status?.kind === "logged_in") {
    return { kind: "logged_in", ...(status.account === undefined ? {} : { account: status.account }) };
  }
  if (status?.kind === "logged_out") {
    return { kind: "failed", reason: "not_logged_in", detail: "claude auth login reported success, yet claude auth status says logged out" };
  }
  return reportedSuccess
    ? { kind: "logged_in" }
    : { kind: "failed", reason: "process_failed", detail: "claude auth login exited 0 without reporting success" };
}

/** A failed exit, in claude's words where it gave any. */
function failedExit(exit: LoginProcessExit, flow: FlowState, secrets: LoginSecrets): LoginResult {
  if (exit.error !== undefined) {
    return { kind: "failed", reason: "process_failed", detail: secrets.line(exit.error) };
  }
  if (flow.failure !== undefined) {
    return { kind: "failed", reason: "rejected", detail: secrets.line(flow.failure) };
  }
  // claude exits 1 for a failure it reports, also in words other than `Login failed:`.
  if (exit.exitCode === 1 && flow.lastStderr !== undefined) {
    return { kind: "failed", reason: "rejected", detail: secrets.line(flow.lastStderr) };
  }
  const ended = exit.exitCode === null ? `signal ${exit.signal ?? "unknown"}` : `code ${String(exit.exitCode)}`;
  return {
    kind: "failed",
    reason: "process_failed",
    detail: flow.lastStderr === undefined ? `claude auth login exited with ${ended}` : secrets.line(flow.lastStderr),
  };
}

async function runClaudeLogin(
  installation: AvailableInstallation,
  command: string,
  interaction: ProviderLoginInteraction,
  timeoutMs: number,
): Promise<LoginResult> {
  const secrets = new LoginSecrets();
  const interactionFailure = Promise.withResolvers<Ending>();
  const flow: FlowState = {
    urlSent: false, pasteOffered: false, promptOpen: false, settled: false, reportedSuccess: false, failure: undefined, lastStderr: undefined,
  };
  let child: LoginProcess | null = null;

  const ended = (): boolean => flow.settled;
  /** The caller failed: settled at once, so no answer still in flight reaches claude. */
  const interactionFailed = (error: unknown): void => {
    flow.settled = true;
    interactionFailure.resolve({ kind: "interaction_failed", message: errorMessage(error) });
  };
  const ask = async (message: string): Promise<void> => {
    if (flow.promptOpen || flow.settled) {
      return;
    }
    flow.promptOpen = true;
    let answer = "";
    try {
      answer = await interaction.prompt({ kind: "manual_code", message, placeholder: "code#state" });
    } catch (error) {
      // A prompt the caller gave up on because it aborted is a cancellation, which the bounds report.
      if (interaction.signal?.aborted !== true) {
        interactionFailed(error);
      }
      return;
    } finally {
      flow.promptOpen = false;
    }
    // The code has no whitespace; a pasted line break must not become a second attempt.
    const code = answer.replaceAll(/\s+/gu, "");
    // Read after the wait: the login may have ended while the caller answered.
    if (ended()) {
      return;
    }
    if (code === "") {
      await ask("No code was entered. Paste the code shown after signing in");
      return;
    }
    // The authorization code is the secret part; the state after `#` is already in the sign-in URL.
    secrets.add(code);
    secrets.add(code.split("#")[0] ?? code);
    // Only ever to claude's stdin: never an event, a result or an error.
    child?.write(`${code}\n`);
  };
  const offerPaste = (): void => {
    if (!flow.pasteOffered) {
      flow.pasteOffered = true;
      void ask("Paste the code shown after signing in");
    }
  };

  try {
    child = spawnLoginProcess(command, ["auth", "login"], claudeEnv(), {
      onLine(line, stream) {
        const url = URL_LINE.exec(line)?.[1];
        if (url !== undefined && !flow.urlSent) {
          flow.urlSent = true;
          try {
            interaction.onEvent({ kind: "auth_url", url, instructions: "Open this URL and sign in; if the page then shows a code, paste it back." });
          } catch (error) {
            // A caller that cannot show the URL cannot finish the login.
            interactionFailed(error);
          }
        }
        if (PASTE_PROMPT.test(line)) {
          offerPaste();
        }
        if (stream === "stderr") {
          flow.lastStderr = line;
          if (INVALID_CODE.test(line)) {
            void ask("That code was not accepted. Paste the full code shown after signing in");
          }
        }
        // Unanchored: with no echo of the pasted line, claude's next words continue the prompt's line.
        if (SUCCESS.test(line)) {
          flow.reportedSuccess = true;
        }
        const failed = FAILURE.exec(line)?.[1];
        if (failed !== undefined) {
          flow.failure = failed;
        }
      },
      onPartial(partial) {
        if (PASTE_PROMPT.test(partial)) {
          offerPaste();
        }
      },
    });
  } catch (error) {
    return { kind: "failed", reason: "process_failed", detail: secrets.line(errorMessage(error)) };
  }

  const bounds = loginBounds(interaction.signal, timeoutMs);
  try {
    const ending = await Promise.race([
      // oxlint-disable-next-line promise/prefer-await-to-then -- racing three endings
      child.exited.then((exit): Ending => ({ kind: "exit", exit })),
      // oxlint-disable-next-line promise/prefer-await-to-then -- racing three endings
      bounds.stopped.then((stop): Ending => ({ kind: "stop", stop })),
      interactionFailure.promise,
    ]);
    flow.settled = true;
    if (ending.kind !== "exit") {
      child.stop();
      await child.exited;
    }
    // After `Login successful.` the new login is stored; a stop or an odd exit while claude flushes does not undo it.
    if (flow.reportedSuccess) {
      return await confirmed(installation, interaction.signal, true);
    }
    switch (ending.kind) {
      case "stop":
        return stoppedResult(ending.stop, timeoutMs);
      case "interaction_failed":
        return { kind: "failed", reason: "interaction_failed", detail: secrets.line(ending.message) };
      case "exit":
        break;
    }
    return ending.exit.exitCode === 0 && ending.exit.error === undefined
      ? await confirmed(installation, interaction.signal, false)
      : failedExit(ending.exit, flow, secrets);
  } finally {
    flow.settled = true;
    bounds.dispose();
  }
}

/** Signs claude in with `claude auth login`, relaying its URL and writing the pasted code to its stdin. */
export async function claudeLogin(
  installation: AvailableInstallation,
  interaction: ProviderLoginInteraction,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const target = loginExecutable(installation, "claude", PASTE_FLOOR);
  if (target.kind === "settled") {
    return target.result;
  }
  if (interaction.signal?.aborted === true) {
    return { kind: "cancelled" };
  }
  const result = await runClaudeLogin(installation, target.installation.command, interaction, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  return result;
}
