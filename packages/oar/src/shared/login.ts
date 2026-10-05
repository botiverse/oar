import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import spawn from "cross-spawn";
import type { AvailableInstallation, ExecutableInstallation } from "../contracts/installation.js";
import type { LoginResult } from "../contracts/login.js";
import { killGraceMs, killProcessTree, OWN_PROCESS_GROUP, signalProcessGroup } from "./executable/index.js";
import { locateExecutable } from "./installation.js";
import { releaseVersion, versionAtLeast } from "./update.js";

/*
 * Mechanisms every login driver shares: running a vendor login command over
 * pipes, reading what it prints, keeping secrets out of what oar reports,
 * and the deadline and cancellation rules of the contract.
 */

const ESC = String.fromCodePoint(0x1B);
const BEL = String.fromCodePoint(0x07);
// OSC (hyperlinks, titles) ends with BEL or ESC \; CSI (colors, cursor moves)
// ends with a final byte in @-~; any other escape is ESC, optional
// intermediates (a charset choice: ESC ( B), and one final byte.
const TERMINAL_ESCAPES = new RegExp(
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}[ -/]*[0-~]`,
  "gu",
);

/** Terminal escapes removed: colors, cursor movement, and OSC 8 hyperlinks (their visible text stays). */
export function stripTerminalEscapes(text: string): string {
  return text.replace(TERMINAL_ESCAPES, "");
}

const TOKEN_SHAPES = [
  /\bsk-[\w-]{16,}/gu, // Anthropic and OpenAI keys and OAuth tokens
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/gu, // JWTs
];
const SECRET_MIN_LENGTH = 6;
const DETAIL_LIMIT = 500;

/**
 * Values that must never leave a login: the codes a person pasted, and any
 * token-shaped text. Everything oar reports from runtime output goes through
 * `redact`.
 */
export class LoginSecrets {
  readonly #values = new Set<string>();

  /** Values too short to be secret on their own (a separator, a single word) are ignored. */
  add(value: string): void {
    if (value.length >= SECRET_MIN_LENGTH) {
      this.#values.add(value);
    }
  }

  redact(text: string): string {
    let redacted = text;
    // Longest first, so a whole code is replaced before any of its parts.
    for (const value of [...this.#values].toSorted((left, right) => right.length - left.length)) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
    for (const shape of TOKEN_SHAPES) {
      redacted = redacted.replace(shape, "[redacted]");
    }
    return redacted.length > DETAIL_LIMIT ? `${redacted.slice(0, DETAIL_LIMIT)}...` : redacted;
  }

  /** The first non-blank line of `text`, redacted: a runtime's one-line reason, never a log tail. */
  line(text: string): string {
    return this.redact(text.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "") ?? "");
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type LoginStream = "stdout" | "stderr";

export interface LoginOutputHandlers {
  /** One complete line from either stream, escapes stripped and trimmed; blank lines are skipped. */
  readonly onLine: (line: string, stream: LoginStream) => void;
  /** A stream's unterminated tail after each chunk, escapes stripped: a prompt printed with no newline. */
  readonly onPartial?: (text: string, stream: LoginStream) => void;
}

export interface LoginProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The spawn error, when the command could not start. */
  readonly error?: string;
}

export interface LoginProcess {
  /** Settles once the command has exited (or failed to start). */
  readonly exited: Promise<LoginProcessExit>;
  /** Write to the command's stdin; a no-op once it has exited. */
  write(text: string): void;
  /**
   * Stop the command and everything it started: SIGTERM to its process
   * group, SIGKILL to the group after the grace period (the tree on
   * Windows). Idempotent.
   */
  stop(): void;
}

const PARTIAL_LIMIT = 64 * 1024;
/** After the command exits, how long something it started may keep the output pipes. */
const PIPE_DRAIN_MS = 2000;

function readStream(
  stream: NodeJS.ReadableStream | null,
  name: LoginStream,
  handlers: LoginOutputHandlers,
): void {
  if (stream === null) {
    return;
  }
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split(/\r\n|\n|\r/u);
    buffer = (lines.pop() ?? "").slice(-PARTIAL_LIMIT);
    for (const raw of lines) {
      const line = stripTerminalEscapes(raw).trim();
      if (line !== "") {
        handlers.onLine(line, name);
      }
    }
    if (buffer !== "") {
      handlers.onPartial?.(stripTerminalEscapes(buffer), name);
    }
  });
  stream.on("end", () => {
    const line = stripTerminalEscapes(buffer + decoder.end()).trim();
    buffer = "";
    if (line !== "") {
      handlers.onLine(line, name);
    }
  });
}

function stopTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    killProcessTree(child);
    return;
  }
  signalProcessGroup(child, "SIGTERM");
  // Kept after the command exits: what it started may outlive it in the group.
  setTimeout(() => {
    signalProcessGroup(child, "SIGKILL");
  }, killGraceMs()).unref();
}

/**
 * Run a login command over pipes (no terminal), in its own process group on
 * POSIX, reading stdout and stderr alike. Nothing it prints is logged or
 * forwarded except through `handlers`. Throws when the command cannot be
 * spawned at all (an invalid path on Windows).
 */
export function spawnLoginProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  handlers: LoginOutputHandlers,
): LoginProcess {
  const child = spawn(command, [...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: OWN_PROCESS_GROUP,
    windowsHide: true,
  });
  let running = true;
  let stopped = false;
  // A write racing the exit fails with EPIPE; the exit reports the outcome.
  child.stdin?.on("error", () => {});
  readStream(child.stdout, "stdout", handlers);
  readStream(child.stderr, "stderr", handlers);
  const exited = new Promise<LoginProcessExit>((resolve) => {
    child.once("error", (error) => {
      running = false;
      resolve({ exitCode: null, signal: null, error: error.message });
    });
    child.once("exit", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      running = false;
      // Something the command started may hold the output pipes open.
      setTimeout(() => {
        resolve({ exitCode, signal });
      }, PIPE_DRAIN_MS).unref();
    });
    // `close` waits for the output pipes, so every line is read before the exit is reported.
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      running = false;
      resolve({ exitCode, signal });
    });
  });
  return {
    exited,
    write(text) {
      if (running && child.stdin?.writable === true) {
        child.stdin.write(text);
      }
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      child.stdin?.end();
      if (running) {
        stopTree(child);
      }
    },
  };
}

export type LoginStop = "timed_out" | "cancelled";

export interface LoginBounds {
  /** Settles when the deadline passes or the caller aborts, whichever comes first. */
  readonly stopped: Promise<LoginStop>;
  dispose(): void;
}

/** The deadline and the caller's abort signal as one promise. */
export function loginBounds(signal: AbortSignal | undefined, timeoutMs: number): LoginBounds {
  const { promise, resolve } = Promise.withResolvers<LoginStop>();
  const timer = setTimeout(() => {
    resolve("timed_out");
  }, timeoutMs);
  // A deadline alone never keeps the host alive; the login process and the caller's prompt do.
  timer.unref();
  const onAbort = (): void => {
    resolve("cancelled");
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) {
    resolve("cancelled");
  }
  return {
    stopped: promise,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** The result for a bounds stop: a timeout is a failure, an abort a cancellation. */
export function stoppedResult(stop: LoginStop, timeoutMs: number): LoginResult {
  return stop === "cancelled"
    ? { kind: "cancelled" }
    : { kind: "failed", reason: "timed_out", detail: `no sign-in within ${String(timeoutMs)} ms` };
}

export type LoginExecutable =
  | { readonly kind: "executable"; readonly installation: ExecutableInstallation }
  /** The login ends before anything runs. */
  | { readonly kind: "settled"; readonly result: LoginResult };

/**
 * The executable to sign in, or the result that ends the login before
 * anything runs: a bundled runtime or a version known to predate `floor` is
 * unsupported, and an executable that is no longer there (found as the
 * installation probe finds it, without spawning) fails alike on every
 * platform, since a missing command started through a Windows shell would
 * only exit. An unreadable version is tried, not refused: the login command
 * itself then answers.
 */
export function loginExecutable(installation: AvailableInstallation, name: string, floor?: string): LoginExecutable {
  if (installation.via !== "executable") {
    return { kind: "settled", result: { kind: "unsupported", reason: "unsupported_installation", detail: "not a machine-installed executable" } };
  }
  const version = installation.version === undefined ? undefined : releaseVersion(installation.version);
  if (floor !== undefined && version !== undefined && !versionAtLeast(version, floor)) {
    return {
      kind: "settled",
      result: { kind: "unsupported", reason: "version_unsupported", detail: `${name} ${floor} or later is required; this is ${version}` },
    };
  }
  if (locateExecutable(installation.command) === null) {
    return { kind: "settled", result: { kind: "failed", reason: "process_failed", detail: `${name} executable not found: ${installation.command}` } };
  }
  return { kind: "executable", installation };
}
