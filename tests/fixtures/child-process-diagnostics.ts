/* oxlint-disable max-statements, max-lines-per-function -- One test-owned observer restores every builtin binding together. */
import childProcess, { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { errorMonitor } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

interface Event { kind: string; atMs: number; stage: string; child?: number; api?: string; executable?: string;
  elapsedMs?: number; status?: number | null; signal?: string | null; code?: string; reason?: string }

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function failure(error: unknown) {
  const code = field(error, "code");
  const status = field(error, "status");
  switch (code) {
    case "ETIMEDOUT": return { code, reason: "child deadline expired" };
    case "ENOENT": return { code, reason: "executable or working directory missing" };
    case "EACCES": case "EPERM": return { code, reason: "permission denied" };
    case "EAGAIN": case "ENOMEM": return { code, reason: "process resources unavailable" };
    case "ENOBUFS": return { code, reason: "output buffer limit reached" };
    case "ABORT_ERR": return { code, reason: "operation aborted" };
    default: return typeof status === "number" && status !== 0
      ? { code: "child_exit", reason: "child exited unsuccessfully" }
      : { code: "other", reason: "unclassified error; original message omitted" };
  }
}

function outcome(result: unknown) {
  const error = field(result, "error"), signal = field(result, "signal"), status = field(result, "status");
  return { status: typeof status === "number" ? status : null,
    signal: typeof signal === "string" && /^SIG[A-Z0-9]{1,12}$/u.test(signal) ? signal : null,
    ...(error === undefined ? {} : failure(error)) };
}

function executable(value: unknown): string {
  if (typeof value !== "string") { return "other"; }
  const name = value.split(/[\\/]/u).at(-1)?.toLowerCase();
  return name !== undefined && ["node", "node.exe", "bash", "bash.exe", "sh", "powershell.exe", "pwsh.exe", "cmd.exe"].includes(name) ? name : "other";
}

/** Observe actual test children, including native SDK imports. Never retain payloads. */
export default function captureChildProcesses(label: string) {
  const detach: (() => void)[] = [], events: Event[] = [];
  const openedAt = performance.now();
  let dropped = 0, nextChild = 0, stage = "setup", stopped = false;
  let stoppedAt: number | undefined = undefined;
  const record = (event: Omit<Event, "atMs" | "stage">) => {
    if (stopped) { return; }
    if (events.length < 128) { events.push({ ...event, atMs: performance.now() - openedAt, stage }); }
    else { dropped += 1; }
  };
  const originals = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync, execSync: childProcess.execSync };
  const watch = (child: ChildProcess, id: number, started: number) => {
    const spawned = () => { record({ kind: "spawned", child: id, elapsedMs: performance.now() - started }); };
    const failed = (error: unknown) => { record({ kind: "error", child: id, elapsedMs: performance.now() - started, ...failure(error) }); };
    const closed = (status: number | null, signal: NodeJS.Signals | null) => { record({ kind: "close", child: id, elapsedMs: performance.now() - started, status, signal }); };
    child.on("spawn", spawned); child.on(errorMonitor, failed); child.on("close", closed);
    detach.push(() => { child.off("spawn", spawned); child.off(errorMonitor, failed); child.off("close", closed); });
  };
  function wrap<T extends typeof childProcess.spawn | typeof childProcess.spawnSync | typeof childProcess.execSync>(original: T, api: string): T {
    return new Proxy(original, { apply(target, receiver: unknown, args: unknown[]) {
      const id = ++nextChild, started = performance.now();
      record({ kind: "start", child: id, api, executable: api === "execSync" ? "shell-command" : executable(args[0]) });
      try {
        const result: unknown = Reflect.apply(target, receiver, args);
        if (result instanceof ChildProcess) { watch(result, id, started); }
        else { record({ kind: "result", child: id, elapsedMs: performance.now() - started, ...(api === "execSync" ? { status: 0, signal: null } : outcome(result)) }); }
        return result;
      } catch (error) {
        record({ kind: "throw", child: id, elapsedMs: performance.now() - started, ...outcome(error), ...failure(error) });
        throw error;
      }
    } });
  }
  childProcess.spawn = wrap(originals.spawn, "spawn");
  childProcess.spawnSync = wrap(originals.spawnSync, "spawnSync");
  childProcess.execSync = wrap(originals.execSync, "execSync");
  syncBuiltinESMExports();
  const snapshot = () => ({ label, platform: process.platform, clock: "performance.now", observedThroughMs: stoppedAt ?? performance.now() - openedAt, dropped, events: [...events] });
  return {
    stage(name: string) { stage = name; record({ kind: "stage" }); },
    snapshot,
    stop() {
      if (stopped) { return; }
      stoppedAt ??= performance.now() - openedAt;
      stopped = true;
      Object.assign(childProcess, originals); syncBuiltinESMExports();
      for (const remove of detach) { remove(); }
    },
    async save() {
      const report = snapshot();
      const directory = join(process.cwd(), "oar-trial-run", "cancellation-timing");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `child-${label}-${randomUUID()}.json`), `${JSON.stringify(report, null, 2)}\n`);
    },
  };
}
