import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { UserShellEnvironmentError, type UserShellEnvironment, type UserShellEnvironmentOptions, type UserShellEnvironmentFailure } from "../contracts/shell-environment.js";
import { asRecord, parseJson } from "./json.js";
import { signalProcessGroup, trackOwnedProcess } from "./executable/process.js";

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const criticalVariables = [
  "HOME", "PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
] as const;

/** POSIX single quotes with adjacent quoted pieces for an apostrophe. */
function quote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

function psQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function rawQuote(value: string): string {
  let hashes = "#";
  while (value.includes(`'${hashes}`)) { hashes += "#"; }
  return `r${hashes}'${value}'${hashes}`;
}
const fishQuote = (value: string): string => `'${value.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`)}'`;

/** Shell dialect only, with no interpolation of environment values into code. */
export function shellEnvironmentCommand(shell: string, executable: string, marker: string): readonly string[] {
  const script = `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(process.env) + ${JSON.stringify(marker)})`;
  const name = basename(shell);
  if (/^(?:pwsh|powershell)(?:-preview)?$/u.test(name)) {
    return ["-Login", "-Command", `& ${psQuote(executable)} -e ${psQuote(script)}`];
  }
  if (name === "nu") {
    return ["-i", "-l", "-c", `^${rawQuote(executable)} -e ${rawQuote(script)}`];
  }
  if (name === "fish") {
    return ["-i", "-l", "-c", `${fishQuote(executable)} -e ${fishQuote(script)}`];
  }
  return ["-i", "-l", "-c", `${quote(executable)} -e ${quote(script)}`];
}

/** Ignore profile chatter outside the two markers, but never accept a missing or malformed payload. */
export function parseShellEnvironment(output: string, marker: string): Record<string, string> {
  const pieces = output.split(marker);
  if (pieces.length !== 3) { throw new UserShellEnvironmentError("invalid_output"); }
  const value = asRecord(parseJson(pieces[1] ?? ""));
  if (value === null) { throw new UserShellEnvironmentError("invalid_output"); }
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === "" || /[=\0]/u.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      throw new UserShellEnvironmentError("invalid_output");
    }
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

/** A private bounded capture: no stderr forwarding, output tails or native error details. */
async function capture(shell: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const output = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const child = spawn(shell, [...args], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    trackOwnedProcess(child);
    const finish = (failure?: UserShellEnvironmentFailure): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (failure !== undefined) {
        // No shutdown work to preserve: a stuck profile and its children must
        // not extend the configured deadline or keep inherited pipes alive.
        if (failure !== "shell_failed" && failure !== "shell_unavailable") { signalProcessGroup(child, "SIGKILL"); }
        child.stdout.destroy(); child.stderr.destroy();
        reject(new UserShellEnvironmentError(failure));
      } else { resolve(Buffer.concat(chunks).toString("utf8")); }
    };
    const aborted = (): void => { finish("cancelled"); };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) { finish("output_too_large"); }
      else { chunks.push(chunk); }
    });
    // Profile diagnostics can contain secrets. Drain without retaining them.
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) { finish("output_too_large"); }
    });
    child.once("error", () => { finish("shell_unavailable"); });
    child.once("close", (code, exitSignal) => { finish(code === 0 && exitSignal === null ? undefined : "shell_failed"); });
    const timer = setTimeout(() => { finish("timed_out"); }, timeoutMs);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted === true) { aborted(); }
  });
  return output;
}

/** A compiled host cannot evaluate -e: starting it would reenter the application. */
async function captureExecutable(): Promise<string> {
  const bun = asRecord(Reflect.get(globalThis, "Bun"));
  if (bun !== null) {
    // Older Bun builds without the documented flag cannot establish this safely.
    if (bun.isStandaloneExecutable !== false) { throw new UserShellEnvironmentError("no_node_runtime"); }
  } else {
    const { isSea } = await import("node:sea");
    if (isSea()) { throw new UserShellEnvironmentError("no_node_runtime"); }
  }
  return process.execPath;
}

/** Explicit, uncached and private: execute the configured login shell once without a terminal. */
export async function userShellEnvironment(options: UserShellEnvironmentOptions = {}): Promise<UserShellEnvironment> {
  if (process.platform === "win32") { throw new UserShellEnvironmentError("unsupported_platform"); }
  if (options.signal?.aborted === true) { throw new UserShellEnvironmentError("cancelled"); }
  const inherited = { ...process.env };
  const shell = inherited.SHELL;
  if (shell === undefined || shell.trim() === "") { throw new UserShellEnvironmentError("shell_not_set"); }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) { throw new RangeError("timeoutMs must be a positive integer that fits a timer"); }
  const executable = await captureExecutable();
  const marker = randomUUID().replaceAll("-", "");
  let output = "";
  try {
    // Electron hosts must execute their binary as Node. This helper-only
    // override is removed or restored before the environment reaches callers.
    output = await capture(shell, shellEnvironmentCommand(shell, executable, marker), { ...inherited, ELECTRON_RUN_AS_NODE: "1" }, timeoutMs, options.signal);
  } catch (error) {
    if (error instanceof UserShellEnvironmentError) { throw error; }
    throw new UserShellEnvironmentError("shell_unavailable");
  }
  const environment = parseShellEnvironment(output, marker);
  if (inherited.ELECTRON_RUN_AS_NODE === undefined) { delete environment.ELECTRON_RUN_AS_NODE; }
  else { environment.ELECTRON_RUN_AS_NODE = inherited.ELECTRON_RUN_AS_NODE; }
  const removed = Object.keys(inherited).filter((key) => inherited[key] !== undefined && !Object.hasOwn(environment, key));
  return {
    env: { ...Object.fromEntries(removed.map((key) => [key, null])), ...environment },
    changedVariables: criticalVariables.filter((key) => environment[key] !== inherited[key]),
  };
}
