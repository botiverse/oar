import path from "node:path";
import vm from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { cursorChildLaunch } from "../../packages/oar/src/runtimes/cursor/subprocess/child-script.js";
import {
  createParentDeathMonitor,
  isWindowsParentReplaced,
  parseWindowsParentSnapshot,
  windowsPowershellPath,
  type ParentProcessSnapshot,
} from "../../packages/oar/src/shared/executable/parent-death.js";

afterEach(() => {
  vi.useRealTimers();
});

test("windowsPowershellPath prefers taskkill's System32 directory for clean environments", () => {
  expect(windowsPowershellPath(String.raw`D:\Win\System32\taskkill.exe`))
    .toBe(String.raw`D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe`);
});

test("parseWindowsParentSnapshot handles single-object and array CIM replies", () => {
  const single = JSON.stringify({ ProcessId: 100, Started: "2026-11-28T10:00:01.0000000Z" });
  expect(parseWindowsParentSnapshot(single, 50, 100)).toEqual({
    parentFound: false,
    parentStart: null,
    selfStart: "2026-11-28T10:00:01.0000000Z",
  });

  const both = JSON.stringify([
    { ProcessId: 50, Started: "2026-11-28T10:00:00.0000000Z" },
    { ProcessId: 100, Started: "2026-11-28T10:00:01.0000000Z" },
  ]);
  expect(parseWindowsParentSnapshot(both, 50, 100)).toEqual({
    parentFound: true,
    parentStart: "2026-11-28T10:00:00.0000000Z",
    selfStart: "2026-11-28T10:00:01.0000000Z",
  });

  expect(parseWindowsParentSnapshot("", 50, 100)).toBeNull();
  expect(parseWindowsParentSnapshot("{bad", 50, 100)).toBeNull();
});

test("isWindowsParentReplaced distinguishes live host from PID reuse and protected replacements", () => {
  const initial = "2026-11-28T10:00:00.0000000Z";
  const self = "2026-11-28T10:00:01.0000000Z";
  expect(isWindowsParentReplaced({ parentFound: true, parentStart: initial, selfStart: self }, initial, false)).toBe(false);
  expect(isWindowsParentReplaced({ parentFound: false, parentStart: null, selfStart: self }, initial, false)).toBe(true);
  expect(isWindowsParentReplaced({ parentFound: true, parentStart: "2026-11-28T10:00:05.0000000Z", selfStart: self }, initial, false)).toBe(true);
  expect(isWindowsParentReplaced({ parentFound: true, parentStart: "2026-11-28T10:00:02.0000000Z", selfStart: self }, null, false)).toBe(true);
  expect(isWindowsParentReplaced({ parentFound: true, parentStart: null, selfStart: self }, initial, false)).toBe(true);
  expect(isWindowsParentReplaced({ parentFound: true, parentStart: null, selfStart: self }, null, true)).toBe(true);
});

function reuseMonitorHarness(): { check: (next: ParentProcessSnapshot | null) => Promise<number>; stop: () => void } {
  let orphans = 0;
  let snapshot: ParentProcessSnapshot | null = null;
  const monitor = createParentDeathMonitor({
    platform: "win32",
    selfPid: 100,
    ppid: () => 50,
    signalZero: () => "alive",
    queryWindowsParent: async () => snapshot,
    onOrphan: () => { orphans += 1; },
  });
  return {
    check: async (next: ParentProcessSnapshot | null): Promise<number> => {
      snapshot = next;
      await monitor.checkNow();
      return orphans;
    },
    stop: () => { monitor.stop(); },
  };
}

test("createParentDeathMonitor detects Windows PID reuse while ignoring transient probe errors", async () => {
  vi.useFakeTimers();
  const harness = reuseMonitorHarness();
  expect(await harness.check({ parentFound: true, parentStart: "2026-11-28T10:00:00.0000000Z", selfStart: "2026-11-28T10:00:01.0000000Z" })).toBe(0);
  expect(await harness.check(null)).toBe(0);
  expect(await harness.check({ parentFound: true, parentStart: "2026-11-28T10:00:09.0000000Z", selfStart: "2026-11-28T10:00:01.0000000Z" })).toBe(1);
  harness.stop();
});

test("createParentDeathMonitor retains Windows ESRCH shutdown on polling interval", async () => {
  vi.useFakeTimers();
  let orphans = 0;
  let killResult: "alive" | "esrch" = "alive";
  const monitor = createParentDeathMonitor({
    platform: "win32",
    selfPid: 100,
    ppid: () => 50,
    signalZero: () => killResult,
    queryWindowsParent: async () => ({ parentFound: true, parentStart: "2026-11-28T10:00:00.0000000Z", selfStart: "2026-11-28T10:00:01.0000000Z" }),
    onOrphan: () => { orphans += 1; },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(orphans).toBe(0);
  killResult = "esrch";
  await vi.advanceTimersByTimeAsync(1000);
  expect(orphans).toBe(1);
  monitor.stop();
});

test("createParentDeathMonitor retains POSIX ppid reparenting check", async () => {
  vi.useFakeTimers();
  let ppid = 50;
  let orphans = 0;
  const monitor = createParentDeathMonitor({ platform: "linux", selfPid: 100, ppid: () => ppid, onOrphan: () => { orphans += 1; } });
  await monitor.checkNow();
  expect(orphans).toBe(0);
  ppid = 1;
  await monitor.checkNow();
  expect(orphans).toBe(1);
  monitor.stop();
});

interface SimulatedChildResult {
  readonly exits: number[];
  readonly disconnect: () => void;
  readonly setRows: (rows: readonly { readonly ProcessId: number; readonly Started: string | null }[]) => void;
  readonly setEsrch: () => void;
}

function createFakeProcess(launch: ReturnType<typeof cursorChildLaunch>, exits: number[], isEsrch: () => boolean) {
  const listeners = new Map<string, (() => void)[]>();
  return {
    platform: "win32",
    arch: "x64",
    pid: 100,
    ppid: 50,
    connected: true,
    env: { ...launch.env },
    argv: ["node", launch.argument],
    send: () => true,
    exit: (code: number) => { exits.push(code); },
    on: (event: string, fn: () => void) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
    emit: (event: string) => { for (const fn of listeners.get(event) ?? []) { fn(); } },
    kill: (pid: number, sig: number | string) => {
      if (sig === 0 && pid === 50 && isEsrch()) { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); }
      return true;
    },
  };
}

function createFakeRequire(getRows: () => readonly { readonly ProcessId: number; readonly Started: string | null }[]) {
  return (id: string): unknown => {
    if (id === "node:path") { return path; }
    if (id === "node:fs") { return { writeSync: () => 0, readdirSync: () => [] }; }
    if (id === "node:module") { return { createRequire: () => ({ resolve: () => "/tmp/package.json" }) }; }
    if (id === "node:child_process") {
      return {
        execFileSync: () => "",
        execFile: (...args: unknown[]) => {
          const done = args.at(3);
          queueMicrotask(() => { if (typeof done === "function") { Reflect.apply(done, null, [null, JSON.stringify(getRows())]); } });
          return { unref: () => undefined, kill: () => true };
        },
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  };
}

function runEmbeddedChildScriptInWindowsSim(): SimulatedChildResult {
  const launch = cursorChildLaunch("fake-sdk-module", { SystemRoot: String.raw`C:\Windows` });
  let rows: readonly { readonly ProcessId: number; readonly Started: string | null }[] = [
    { ProcessId: 50, Started: "2026-11-28T10:00:00.0000000Z" },
    { ProcessId: 100, Started: "2026-11-28T10:00:01.0000000Z" },
  ];
  let esrch = false;
  const exits: number[] = [];
  const fakeProcess = createFakeProcess(launch, exits, () => esrch);
  const context = vm.createContext({
    require: createFakeRequire(() => rows),
    process: fakeProcess,
    setInterval, clearInterval, setTimeout, clearTimeout,
    Map, Set, Error, Promise, JSON, String, Number, Array,
  });
  vm.runInContext(launch.script, context);
  return { exits, disconnect: () => { fakeProcess.emit("disconnect"); }, setRows: (next) => { rows = next; }, setEsrch: () => { esrch = true; } };
}

test("embedded cursor child script exits when parent PID is reused", async () => {
  vi.useFakeTimers();
  const child = runEmbeddedChildScriptInWindowsSim();
  await vi.advanceTimersByTimeAsync(1100);
  expect(child.exits).toEqual([]);
  child.setRows([
    { ProcessId: 50, Started: "2026-11-28T10:00:09.0000000Z" },
    { ProcessId: 100, Started: "2026-11-28T10:00:01.0000000Z" },
  ]);
  await vi.advanceTimersByTimeAsync(1100);
  expect(child.exits).toEqual([1]);
});

test("embedded cursor child script retains ESRCH and IPC disconnect exits", async () => {
  vi.useFakeTimers();
  const byEsrch = runEmbeddedChildScriptInWindowsSim();
  byEsrch.setEsrch();
  await vi.advanceTimersByTimeAsync(1100);
  expect(byEsrch.exits).toEqual([1]);

  const byDisconnect = runEmbeddedChildScriptInWindowsSim();
  byDisconnect.disconnect();
  await vi.advanceTimersByTimeAsync(100);
  expect(byDisconnect.exits).toEqual([1]);
});
