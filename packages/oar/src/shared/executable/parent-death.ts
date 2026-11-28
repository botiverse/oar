import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { environmentValue } from "../environment.js";
import { asRecord, parseJson } from "../json.js";

export interface ParentProcessSnapshot {
  readonly parentFound: boolean;
  readonly parentStart: string | null;
  readonly selfStart: string | null;
}

export interface ParentMonitorOptions {
  readonly platform?: NodeJS.Platform;
  readonly selfPid?: number;
  readonly taskkill?: string | null;
  readonly ppid?: () => number;
  readonly signalZero?: (pid: number) => "alive" | "esrch" | "eperm";
  readonly queryWindowsParent?: (parentPid: number, selfPid: number) => Promise<ParentProcessSnapshot | null>;
  readonly pollIntervalMs?: number;
  readonly onOrphan: () => void;
}

export interface ParentDeathMonitor {
  readonly checkNow: () => Promise<void>;
  readonly stop: () => void;
}

/** Windows: resolve powershell.exe from taskkill's directory so envBase: "clean" still finds it. */
export function windowsPowershellPath(taskkill: string | null): string {
  const systemRoot = environmentValue(process.env, "SystemRoot", "win32") ?? String.raw`C:\Windows`;
  const system32 = taskkill !== null && taskkill !== ""
    ? path.win32.dirname(taskkill)
    : path.win32.join(systemRoot, "System32");
  return path.win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Parse Windows CIM JSON for the parent and child start times; returns null when inconclusive. */
export function parseWindowsParentSnapshot(stdout: string, parentPid: number, selfPid: number): ParentProcessSnapshot | null {
  const trimmed = stdout.trim();
  if (trimmed === "") { return null; }
  const parsed = parseJson(trimmed);
  if (parsed === undefined) { return null; }
  const rows: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const byPid = new Map<number, string | null>();
  for (const item of rows) {
    const row = asRecord(item);
    if (row === null || typeof row.ProcessId !== "number" || !Number.isInteger(row.ProcessId)) { continue; }
    byPid.set(row.ProcessId, typeof row.Started === "string" && row.Started !== "" ? row.Started : null);
  }
  const selfStart = byPid.get(selfPid);
  if (typeof selfStart !== "string") { return null; }
  return {
    parentFound: byPid.has(parentPid),
    parentStart: byPid.get(parentPid) ?? null,
    selfStart,
  };
}

/** True when a Windows parent observation proves the original host exited or had its PID reassigned. */
export function isWindowsParentReplaced(
  snapshot: ParentProcessSnapshot,
  initialParentStart: string | null,
  parentAccessDenied: boolean,
): boolean {
  if (!snapshot.parentFound) { return true; }
  if (snapshot.selfStart === null) { return false; }
  if (snapshot.parentStart === null) {
    return initialParentStart !== null || parentAccessDenied;
  }
  if (snapshot.parentStart > snapshot.selfStart) { return true; }
  return initialParentStart !== null && snapshot.parentStart !== initialParentStart;
}

function defaultSignalZero(pid: number): "alive" | "esrch" | "eperm" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = asRecord(error)?.code;
    return code === "ESRCH" ? "esrch" : "eperm";
  }
}

async function queryWindowsParentSnapshot(
  parentPid: number,
  selfPid: number,
  powershell: string,
  onChild: (child: ChildProcess | null) => void,
): Promise<ParentProcessSnapshot | null> {
  if (!Number.isInteger(parentPid) || parentPid <= 0 || !Number.isInteger(selfPid) || selfPid <= 0) {
    return null;
  }
  const command = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(parentPid)} OR ProcessId=${String(selfPid)}' | Select-Object ProcessId,@{Name='Started';Expression={if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }}}) | ConvertTo-Json -Compress`;
  const result = await new Promise<ParentProcessSnapshot | null>((resolve) => {
    const child = execFile(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
      (error, stdout) => {
        onChild(null);
        if (error !== null) {
          resolve(null);
          return;
        }
        resolve(parseWindowsParentSnapshot(stdout, parentPid, selfPid));
      },
    );
    child.unref();
    onChild(child);
  });
  return result;
}

/**
 * Watches whether the child's original parent process is still the same host:
 * POSIX detects reparenting synchronously via `ppid`; Windows keeps the dead
 * parent's PID, so it combines `process.kill(ppid, 0)` with CIM `CreationDate`.
 */
export function createParentDeathMonitor(options: ParentMonitorOptions): ParentDeathMonitor {
  const platform = options.platform ?? process.platform;
  const selfPid = options.selfPid ?? process.pid;
  const getPpid = options.ppid ?? ((): number => process.ppid);
  const signalZero = options.signalZero ?? defaultSignalZero;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const powershell = windowsPowershellPath(options.taskkill ?? null);
  const initialParentPid = getPpid();
  let initialParentStart: string | null = null;
  let stopped = false;
  let probeChild: ChildProcess | null = null;
  let inFlight: Promise<void> | null = null;
  const queryWindows = options.queryWindowsParent ?? (async (parentPid, pid): Promise<ParentProcessSnapshot | null> => {
    const snapshot = await queryWindowsParentSnapshot(parentPid, pid, powershell, (child) => { probeChild = child; });
    return snapshot;
  });

  let timer: NodeJS.Timeout | undefined = undefined;
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
    if (probeChild !== null) {
      try { probeChild.kill(); } catch { /* Already exited. */ }
      probeChild = null;
    }
  };
  const isStopped = (): boolean => stopped;
  const trigger = (): void => {
    if (stopped) { return; }
    stop();
    options.onOrphan();
  };

  const checkNow = async (): Promise<void> => {
    if (stopped) { return; }
    if (getPpid() !== initialParentPid) {
      trigger();
      return;
    }
    if (platform !== "win32") { return; }
    const probe = signalZero(initialParentPid);
    if (probe === "esrch") {
      trigger();
      return;
    }
    if (inFlight !== null) {
      await inFlight;
      return;
    }
    const pending = (async (): Promise<void> => {
      try {
        const snapshot = await queryWindows(initialParentPid, selfPid);
        if (isStopped() || snapshot === null) { return; }
        if (isWindowsParentReplaced(snapshot, initialParentStart, probe === "eperm")) {
          trigger();
          return;
        }
        if (initialParentStart === null && snapshot.parentStart !== null) {
          initialParentStart = snapshot.parentStart;
        }
      } finally {
        inFlight = null;
      }
    })();
    inFlight = pending;
    await pending;
  };

  timer = setInterval(() => { void checkNow(); }, pollIntervalMs);
  timer.unref();
  return { checkNow, stop };
}
