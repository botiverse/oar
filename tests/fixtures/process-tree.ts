import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** The stand-in agent (fake-agent-process.mjs): run it with `process.execPath`. */
export const fakeAgent = fileURLToPath(new URL("fake-agent-process.mjs", import.meta.url));
/** The process-tree module alone, for `node --import` into another fixture. */
export const agentTreeModule = new URL("agent-tree.mjs", import.meta.url).href;

export const fixtureIdentityPath = import.meta.filename;
// Keep reporting on the shell's timed path cheap. A function gives the procfs
// parser its own positional parameters. Field 22 follows the last ')' in stat.
const shellStart = process.platform === "linux"
  ? `IFS= read -r stat < "/proc/$pid/stat" || return 1
     set -- \${stat##*) }
     start=\${20:?missing start time}`
  : `start=$(LC_ALL=C /bin/ps -p "$pid" -o lstart=) || return 1
     start=\${start#"\${start%%[![:space:]]*}"}
     start=\${start%"\${start##*[![:space:]]}"}`;
const shellReporter = `report_fixture() { pid=$1; ${shellStart}; printf '{"pid":%s,"start":"%s","root":%s}\\n' "$pid" "$start" "$$"; }`;
export const reportShellChild = `${shellReporter}; report_fixture "$!"`;
export const reportShellSelf = `${shellReporter}; report_fixture "$$"`;

/** Concurrent suites share only builds with identical source. */
function windowsReaderPath(): string {
  const source = readFileSync(new URL("process-start.cs", import.meta.url));
  const hash = createHash("sha256").update(source).digest("hex");
  return path.resolve(import.meta.dirname, "../../node_modules/.cache/oar-fixtures", `process-start-${hash}.exe`);
}
const windowsReader = process.platform === "win32" ? windowsReaderPath() : "";

/** Build the fixture once before timed tests. A PowerShell startup alone can exceed their deadline. */
export function prepareProcessStart(): string {
  if (process.platform !== "win32" || existsSync(windowsReader)) { return windowsReader; }
  const directory = path.dirname(windowsReader);
  mkdirSync(directory, { recursive: true });
  const stage = mkdtempSync(path.join(directory, "build-"));
  try { compileReader(path.join(stage, "process-start.exe")); }
  finally { rmSync(stage, { recursive: true, force: true }); }
  return windowsReader;
}

function compileReader(executable: string): void {
  const compiler = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const source = fileURLToPath(new URL("process-start.cs", import.meta.url));
  execFileSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source]);
  // Another Vitest instance may have published an identical completed build.
  try { linkSync(executable, windowsReader); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) { throw error; } }
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly start: string;
}

// The standalone Node fixtures import this module directly, including those with a
// subsecond runtime deadline. Read just one identity without loading a TS runner.
function missingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}

function procfsStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // Field 22 is the start in clock ticks. The command in field 2 may contain ')'.
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ").at(19);
    assert.ok(start !== undefined && /^\d+$/u.test(start), "Invalid procfs start time");
    return start;
  } catch (error) { if (missingProcess(error) && existsSync("/proc/self/stat")) { return undefined; } throw error; }
}

export function processStart(pid: number): string | undefined {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "Invalid fixture PID");
  if (process.platform === "linux") { return procfsStart(pid); }
  const result = process.platform === "win32"
    ? spawnSync(prepareProcessStart(), [String(pid)], { encoding: "utf8", timeout: 5000, windowsHide: true })
    : spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" }, encoding: "utf8", timeout: 5000 });
  if (result.error !== undefined) { throw result.error; }
  if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") { return undefined; }
  assert.ok(result.status === 0 && result.stdout.trim() !== "", `Unable to identify fixture process ${String(pid)}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Record the process while the fixture still owns it, before triggering cleanup. */
export function captureProcess(pid: number): ProcessIdentity {
  const start = processStart(pid);
  assert.ok(start !== undefined, `Missing fixture process ${String(pid)}`);
  return { pid, start };
}

/** Publish a complete identity from the process or its owner at spawn. */
export function writeProcessReport(file: string, pid: number): void {
  const identity = captureProcess(pid);
  writeFileSync(`${file}.tmp`, JSON.stringify(identity));
  renameSync(`${file}.tmp`, file);
}

/** Decode a child report without looking up the current owner of its PID. */
export function reportedProcess(value: unknown): ProcessIdentity {
  assert.ok(typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number"
    && Number.isSafeInteger(value.pid) && value.pid > 0 && "start" in value && typeof value.start === "string" && value.start.length > 0,
    "Missing fixture process identity");
  return { pid: value.pid, start: value.start };
}

export function reportedCleanupTree(line: string): { root: ProcessIdentity; tool: ProcessIdentity } {
  const value: unknown = JSON.parse(line);
  assert.ok(typeof value === "object" && value !== null && "root" in value && "tool" in value);
  return { root: reportedProcess(value.root), tool: reportedProcess(value.tool) };
}

/** The pids a fake agent reports (agent-tree.mjs): itself, and the tool it started. */
export interface AgentTree {
  readonly agent: ProcessIdentity;
  readonly grandchild: ProcessIdentity;
}

/** One fake agent's scratch directory: the env that grows its tree, and where it reports it. */
export interface TreeProbe {
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  /** The reported pids, once the grandchild runs. */
  tree(): Promise<AgentTree>;
  /** The pid of the tool the agent started on SIGTERM (`lateTool`), once it runs. */
  lateTool(): Promise<ProcessIdentity>;
}

/** How the fake agent behaves (agent-tree.mjs): see the env switches there. */
export interface TreeProbeOptions {
  readonly ignoreSigterm: boolean;
  /** Its tool runs in a session of its own (POSIX). */
  readonly detachTool?: boolean;
  /** With `ignoreSigterm`: the SIGTERM starts one more tool, in a session of its own. */
  readonly lateTool?: boolean;
}

/** `process.kill` found no such process. */
function noSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

export function alive(processId: ProcessIdentity): boolean {
  return processStart(processId.pid) === processId.start;
}

function terminateWindowsFixture(processId: ProcessIdentity): boolean {
  const result = spawnSync(prepareProcessStart(), [String(processId.pid), processId.start], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (result.error !== undefined) { throw result.error; }
  assert.ok(result.status === 0 || (result.status === 1 && result.stderr.trim() === ""), result.stderr);
  return result.status === 0;
}

/** Only signal the original fixture process. An exit between observation and signal is normal. */
export function signalFixture(processId: ProcessIdentity, signal: NodeJS.Signals = "SIGKILL"): boolean {
  if (process.platform === "win32") {
    assert.ok(signal === "SIGKILL" || signal === "SIGTERM");
    return terminateWindowsFixture(processId);
  }
  if (!alive(processId)) { return false; }
  try { return process.kill(processId.pid, signal); }
  catch (error) { if (!noSuchProcess(error)) { throw error; } return false; }
}

/** Poll `predicate` until it holds; false when the deadline passes first. */
export async function eventually(predicate: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = performance.now() + withinMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      return false;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling: each wait follows the previous check
    await delay(20);
  }
  return true;
}

/** Wait until the recorded fixture exits, including when its PID has already been reused. */
export async function gone(pid: ProcessIdentity, withinMs = 5000): Promise<boolean> {
  return eventually(() => !alive(pid), withinMs);
}

/** How long `work` takes to settle, in milliseconds. */
export async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

/**
 * Run `body` with a scratch directory whose env makes a fake agent grow its
 * tree; afterwards SIGKILL whatever the agent reported and is still alive (a
 * failed test must not leak) and remove the directory.
 */
export async function withTreeProbe<Result>(
  options: TreeProbeOptions,
  body: (probe: TreeProbe) => Promise<Result>,
): Promise<Result> {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-process-tree-"));
  const pidFile = path.join(dir, "pids.json");
  const lateFile = path.join(dir, "late.pid");
  let tree: AgentTree | undefined = undefined;
  try {
    return await body({
      dir,
      env: {
        OAR_FIXTURE_PIDS: pidFile,
        ...(options.ignoreSigterm ? { OAR_FIXTURE_IGNORE_SIGTERM: "1" } : {}),
        ...(options.detachTool === true ? { OAR_FIXTURE_DETACH_TOOL: "1" } : {}),
        ...(options.lateTool === true ? { OAR_FIXTURE_LATE_TOOL: lateFile } : {}),
      },
      async tree() {
        if (!await eventually(() => existsSync(pidFile), 10_000)) {
          throw new Error(`the fake agent never reported its pids in ${pidFile}`);
        }
        // The fixture renames a complete file into place, so one read suffices.
        tree = readTree(pidFile);
        return tree;
      },
      async lateTool() {
        if (!await eventually(() => existsSync(lateFile), 10_000)) {
          throw new Error(`the fake agent never reported a late tool in ${lateFile}`);
        }
        return reportedProcess(JSON.parse(readFileSync(lateFile, "utf8")));
      },
    });
  } finally {
    await reap(tree, { pidFile, lateFile, dir });
  }
}

function readTree(file: string): AgentTree {
  const row: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(typeof row === "object" && row !== null && "agent" in row && "grandchild" in row);
  return { agent: reportedProcess(row.agent), grandchild: reportedProcess(row.grandchild) };
}

/** Also collect a report a test failed before it could consume. */
async function reap(tree: AgentTree | undefined, files: { pidFile: string; lateFile: string; dir: string }): Promise<void> {
  const { pidFile, lateFile, dir } = files;
  const owned = tree ?? (existsSync(pidFile) ? readTree(pidFile) : undefined);
  if (owned !== undefined) { signalFixture(owned.agent); signalFixture(owned.grandchild); }
  if (existsSync(lateFile)) {
    const late: unknown = JSON.parse(readFileSync(lateFile, "utf8"));
    signalFixture(reportedProcess(late));
  }
  // Let process exit/close handlers run while Windows releases open files,
  // so a failed assertion is not masked by a still-locked fixture directory.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * An adapter's installation.command. POSIX exec keeps the agent's pid;
 * Windows deliberately keeps a .cmd launcher, so killing only that wrapper
 * cannot pass the agent/descendant liveness assertions.
 */
export function fakeAgentBinary(dir: string, entry: readonly string[] = [fakeAgent]): string {
  const windows = process.platform === "win32";
  const binary = path.join(dir, windows ? "fake-agent.cmd" : "fake-agent");
  const command = [process.execPath, ...entry].map((arg) => `"${arg}"`).join(" ");
  writeFileSync(binary, windows ? `@echo off\r\n${command} %*\r\n` : `#!/bin/sh\nexec ${command} "$@"\n`);
  chmodSync(binary, 0o755);
  return binary;
}
