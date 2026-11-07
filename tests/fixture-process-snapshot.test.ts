import { ChildProcess, type ExecException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { snapshotFixtureProcesses } from "../sea-trial/harness/fixture-process-snapshot.js";

type Callback = (error: ExecException | null, stdout: string, stderr: string) => void;
type Launch = (...args: [string, readonly string[], ExecFileOptionsWithStringEncoding, Callback]) => ChildProcess;
const mocks = vi.hoisted(() => ({ execFile: vi.fn<Launch>(), kill: vi.fn(() => true), unref: vi.fn<() => void>() }));
vi.mock("node:child_process", async (original) => ({ ...await original<{ ChildProcess: typeof ChildProcess }>(), execFile: mocks.execFile }));
let child = new ChildProcess();
let callback: Callback | undefined = undefined;
beforeEach(() => {
  vi.useFakeTimers();
  child = new ChildProcess();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  vi.spyOn(child, "kill").mockImplementation(mocks.kill);
  vi.spyOn(child, "unref").mockImplementation(mocks.unref);
  callback = undefined;
  mocks.execFile.mockImplementation((...args) => { const [_file, _args, _options, onExit] = args; callback = onExit; return child; });
});
afterEach(() => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

function reply(stdout: string, error: ExecException | null = null): void {
  expect(callback).toBeDefined();
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Drive the real execFile callback contract, including a callback arriving after timeout.
  callback?.(error, stdout, "untrusted stderr must not be recorded");
}

test("the query requests only names and ids and drops unrequested output fields", async () => {
  const pending = snapshotFixtureProcesses();
  reply(JSON.stringify([{ Name: "codex.exe", ProcessId: 17, ParentProcessId: 3, CommandLine: "secret argument", ExecutablePath: "private path" }]));
  expect(await pending).toEqual({ outcome: "captured", processes: [{ name: "codex.exe", pid: 17, parentPid: 3 }], truncated: false });
  const [file, args, options] = mocks.execFile.mock.calls[0] ?? [];
  expect(file).toBe("powershell.exe");
  expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", expect.any(String)]);
  expect(args?.at(-1)).toContain("-Property Name,ProcessId,ParentProcessId");
  expect(args?.at(-1)).not.toMatch(/CommandLine|ExecutablePath/u);
  expect(options).toEqual({ encoding: "utf8", windowsHide: true, maxBuffer: 512 * 1024 });
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["[]", '{"Name":"node.exe","ProcessId":8,"ParentProcessId":0}'])("empty and single-row native output remain facts: %s", async (stdout) => {
  const pending = snapshotFixtureProcesses();
  reply(stdout);
  expect(await pending).toEqual({ outcome: "captured", processes: stdout === "[]" ? [] : [{ name: "node.exe", pid: 8, parentPid: 0 }], truncated: false });
});

test("a large table is explicitly truncated without adding another query", async () => {
  const pending = snapshotFixtureProcesses();
  reply(JSON.stringify(Array.from({ length: 1025 }, (_, pid) => ({ Name: "worker.exe", ProcessId: pid, ParentProcessId: 0 }))));
  const result = await pending;
  expect(result.outcome).toBe("captured");
  if (result.outcome !== "captured") { return; }
  expect(result.truncated).toBe(true);
  expect(result.processes).toHaveLength(1024);
  expect(result.processes.at(-1)).toEqual({ name: "worker.exe", pid: 1023, parentPid: 0 });
  expect(mocks.execFile).toHaveBeenCalledOnce();
});

test.each(["not JSON", "null", '{"Name":"node.exe","ProcessId":-1,"ParentProcessId":3}', '{"Name":"node.exe","ProcessId":2.5,"ParentProcessId":3}', '{"Name":"node.exe","ProcessId":4}'])("invalid native output is a diagnostic failure: %s", async (stdout) => {
  const pending = snapshotFixtureProcesses();
  reply(stdout);
  expect(await pending).toEqual({ outcome: "failed", reason: "invalid_output" });
});

test.each(["ENOENT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"])("query failure %s retains no command or stderr", async (code) => {
  const pending = snapshotFixtureProcesses();
  reply("private stdout", Object.assign(new Error("secret command or stderr"), { code, cmd: "secret command" }));
  expect(await pending).toEqual({ outcome: "failed", reason: code === "ENOENT" ? "query" : "output_limit" });
  expect(vi.getTimerCount()).toBe(0);
});

test("a synchronous launcher failure is nonfatal and clears the observer deadline", async () => {
  mocks.execFile.mockImplementation(() => { throw new Error("private launch failure"); });
  expect(await snapshotFixtureProcesses()).toEqual({ outcome: "failed", reason: "spawn" });
  expect(vi.getTimerCount()).toBe(0);
});

test.each([false, true])("an unreturned callback is bounded even if kill throws=%s", async (throws) => {
  if (throws) { mocks.kill.mockImplementation(() => { throw new Error("cannot stop observer"); }); }
  const pending = snapshotFixtureProcesses();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toEqual({ outcome: "timeout" });
  expect(mocks.kill).toHaveBeenCalledOnce();
  expect({ stdin: child.stdin?.destroyed, stdout: child.stdout?.destroyed, stderr: child.stderr?.destroyed, timers: vi.getTimerCount() })
    .toEqual({ stdin: true, stdout: true, stderr: true, timers: 0 });
  expect(mocks.unref).toHaveBeenCalled();
  reply("[]");
  expect(await pending).toEqual({ outcome: "timeout" });
});
