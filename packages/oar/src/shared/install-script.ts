import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isolatedOutput, runIsolated, type IsolatedResult } from "./executable/isolated.js";
import { privateTempDir } from "./private-temp.js";

/** Parsed representation of a vendor `curl -fsSL <url> | [KEY=VALUE ...] sh|bash [args...]` line. */
export interface ScriptStepSpec {
  readonly url: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: "sh" | "bash";
  readonly args: readonly string[];
}

export interface ScriptRunOutcome {
  readonly outcome: "completed" | "download_failed" | "non_script_response" | "timed_out" | "installer_failed";
  readonly exitCode: number | null;
  readonly output: string;
  /** True only when the target installer shell/process actually started. */
  readonly ranInstaller: boolean;
}

const SCRIPT_LINE_RE = /^curl -fsSL (https?:\/\/\S+) \| ((?:[A-Za-z_][A-Za-z0-9_]*=\S+ )*)(sh|bash)(?: (.+))?$/u;
const UNSAFE_TOKEN_RE = /['"`;|&<>()$\r\n\\]/u;
const SHEBANG_PROBE_BYTES = 512;
const HTML_PREFIX_RE = /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/iu;

/**
 * Parse a vendor `curl | sh/bash` command into structured download + shell inputs
 * without invoking an outer pipeline shell.
 */
export function parseScriptInstallLine(line: string): ScriptStepSpec {
  const match = SCRIPT_LINE_RE.exec(line);
  if (match === null) {
    throw new Error(`Unsupported script install line: ${line}`);
  }
  const [, url, rawEnv = "", shellToken, rawArgs = ""] = match;
  if (url === undefined || UNSAFE_TOKEN_RE.test(url) || (shellToken !== "sh" && shellToken !== "bash")) {
    throw new Error(`Unsupported script install line: ${line}`);
  }
  const envEntries: [string, string][] = [];
  for (const pair of rawEnv.trim().split(/\s+/u).filter((token) => token !== "")) {
    const eq = pair.indexOf("=");
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (UNSAFE_TOKEN_RE.test(value)) {
      throw new Error(`Unsupported script installer env assignment for ${key}`);
    }
    envEntries.push([key, value]);
  }
  const args = rawArgs.trim() === "" ? [] : rawArgs.trim().split(/\s+/u);
  for (const arg of args) {
    if (UNSAFE_TOKEN_RE.test(arg) || arg === "-c") {
      throw new Error(`Unsupported script installer argument: ${arg}`);
    }
  }
  return { url, env: Object.fromEntries(envEntries), shell: shellToken, args };
}

/** Concatenate step outputs without joining adjacent non-empty lines without a newline. */
export function appendStepOutput(output: string, addition: string): string {
  if (addition === "") {
    return output;
  }
  if (output === "" || output.endsWith("\n")) {
    return `${output}${addition}`;
  }
  return `${output}\n${addition}`;
}

function stripLeadingHtmlComments(input: string): string {
  let remaining = input.trimStart();
  while (remaining.startsWith("<!--")) {
    const close = remaining.indexOf("-->", 4);
    if (close === -1) {
      break;
    }
    remaining = remaining.slice(close + 3).trimStart();
  }
  return remaining;
}

function readScriptHead(scriptPath: string): { readonly size: number; readonly head: Buffer } | null {
  try {
    const fd = openSync(scriptPath, "r");
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(SHEBANG_PROBE_BYTES, size));
      const bytesRead = buf.length === 0 ? 0 : readSync(fd, buf, 0, buf.length, 0);
      return { size, head: buf.subarray(0, bytesRead) };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function validateDownloadedScript(scriptPath: string, url: string): string | null {
  const sample = readScriptHead(scriptPath);
  if (sample === null) {
    return `[oar: downloaded installer from ${url} could not be opened after curl exited 0; refusing to execute]\n`;
  }
  if (sample.head.length >= 2 && sample.head[0] === 0x23 && sample.head[1] === 0x21) {
    return null;
  }
  if (sample.size === 0) {
    return `[oar: downloaded installer from ${url} was empty (0 bytes); refusing to execute]\n`;
  }
  const unit = sample.size === 1 ? "byte" : "bytes";
  const preview = stripLeadingHtmlComments(sample.head.toString("utf8").replace(/^\uFEFF/u, ""));
  const kindNote = HTML_PREFIX_RE.test(preview) ? ", looks like HTML" : "";
  return `[oar: downloaded installer from ${url} did not start with #! (${String(sample.size)} ${unit}${kindNote}); refusing to execute]\n`;
}

async function runWithStdinFile(
  shell: "sh" | "bash",
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  scriptPath: string,
): Promise<IsolatedResult> {
  const stdinFd = openSync(scriptPath, "r");
  try {
    return await runIsolated(shell, args, { env, timeoutMs, stdinFd });
  } finally {
    closeSync(stdinFd);
  }
}

/**
 * Execute a script install step by downloading with `curl -fsSL` to a private
 * temporary file, verifying a leading `#!` shebang, and feeding that file on stdin
 * to the vendor shell so download errors and HTML/text responses are never masked.
 */
export async function runScriptStep(
  spec: ScriptStepSpec,
  remainingTimeoutMs: number,
  totalTimeoutMs: number,
  baseEnv: NodeJS.ProcessEnv,
): Promise<ScriptRunOutcome> {
  const deadline = Date.now() + remainingTimeoutMs;
  const temp = await privateTempDir("oar-install-script-");
  try {
    const scriptPath = path.join(temp.path, "install.sh");
    const download = await runIsolated("curl", ["-fsSL", "-o", scriptPath, "--", spec.url], {
      env: baseEnv,
      timeoutMs: Math.max(deadline - Date.now(), 1),
    });
    const downloadOutput = isolatedOutput(download, totalTimeoutMs, "installer");
    if (download.timedOut) {
      return { outcome: "timed_out", exitCode: null, output: downloadOutput, ranInstaller: false };
    }
    if (download.exitCode !== 0) {
      return { outcome: "download_failed", exitCode: download.exitCode, output: downloadOutput, ranInstaller: false };
    }
    const refusal = validateDownloadedScript(scriptPath, spec.url);
    if (refusal !== null) {
      return { outcome: "non_script_response", exitCode: null, output: appendStepOutput(downloadOutput, refusal), ranInstaller: false };
    }
    const shellBudgetMs = deadline - Date.now();
    if (shellBudgetMs <= 0) {
      return {
        outcome: "timed_out",
        exitCode: null,
        output: appendStepOutput(downloadOutput, `[oar: stopped the installer after ${String(totalTimeoutMs)} ms]\n`),
        ranInstaller: false,
      };
    }
    const execEnv = Object.keys(spec.env).length === 0 ? baseEnv : { ...baseEnv, ...spec.env };
    const execRun = await runWithStdinFile(spec.shell, spec.args, execEnv, shellBudgetMs, scriptPath);
    const combinedOutput = appendStepOutput(downloadOutput, isolatedOutput(execRun, totalTimeoutMs, "installer"));
    if (execRun.timedOut) {
      return { outcome: "timed_out", exitCode: null, output: combinedOutput, ranInstaller: true };
    }
    if (execRun.exitCode !== 0) {
      return { outcome: "installer_failed", exitCode: execRun.exitCode, output: combinedOutput, ranInstaller: true };
    }
    return { outcome: "completed", exitCode: 0, output: combinedOutput, ranInstaller: true };
  } finally {
    temp.remove();
  }
}
