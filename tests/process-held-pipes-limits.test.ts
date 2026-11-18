import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { HeldPipes } from "../packages/oar/src/shared/executable/process-cleanup-diagnostics.js";
import type { ProcessEntry, ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";

// The edges of closing an exited root's held pipes (pipe-close.ts), with the
// process table and the ownership it hands over stubbed: a pipe that closes
// while the table is read, and a reader that never takes its data.
// The bounded wait itself: process-held-pipes.test.ts.
const read = vi.hoisted(() => { const members: ProcessEntry[] = []; return { during: (): void => {}, members }; });
vi.mock("../packages/oar/src/shared/executable/process-table-async.js", async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, observeProcessTableAsync: vi.fn(async (): Promise<ProcessTableObservation> => {
    await delay(10);
    read.during();
    return { ok: true, source: "procfs", elapsedMs: 10, skipped: 0, table: new Map(read.members.map((entry) => [entry.pid, entry])) };
  }) };
});
vi.mock("../packages/oar/src/shared/executable/ownership.js", () => ({ ownLeftProcesses: vi.fn() }));
const { closePipesAfterExit } = await import("../packages/oar/src/shared/executable/pipe-close.js");
const { ownLeftProcesses } = await import("../packages/oar/src/shared/executable/ownership.js");

const posix = process.platform !== "win32";
// An exited root: only its pid is used, as the group id of the stubbed member.
const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
await once(child, "exit");
const member: ProcessEntry = { pid: 424_243, ppid: 1, pgid: child.pid ?? 0, start: "7" };
read.members = [member];

/** A pipe whose reader paused with data it has not taken. */
function pausedWithData(): PassThrough {
  const pipe = new PassThrough();
  pipe.on("data", () => {});
  pipe.pause();
  pipe.write("unread");
  return pipe;
}

afterEach(() => { read.during = (): void => {}; vi.mocked(ownLeftProcesses).mockClear(); });

test.skipIf(!posix)("a pipe that closes while the holders are read is not reported as closed by OAR", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.resume(); stderr.resume();
  read.during = (): void => { stdout.destroy(); };
  const held = await closePipesAfterExit(child, [{ name: "stdout", stream: stdout }, { name: "stderr", stream: stderr }], 20);
  expect({ pipes: held?.pipes, holders: held?.holders, stderrClosed: stderr.destroyed }).toEqual({ pipes: ["stderr"], holders: [member.pid], stderrClosed: true });
});

test.skipIf(!posix)("when every held pipe closes while the holders are read, OAR closed nothing: no report, nothing owned", async () => {
  const stdout = new PassThrough();
  stdout.resume();
  read.during = (): void => { stdout.destroy(); };
  expect(await closePipesAfterExit(child, [{ name: "stdout", stream: stdout }], 20)).toBeUndefined();
  expect(ownLeftProcesses).not.toHaveBeenCalled();
});

// Maintainer follow-up: a reader that never takes its data must neither keep the recheck running nor keep the root owned.
test.skipIf(!posix)("a pipe whose reader does not take its data within the limit is left to it: the recheck stops and the root's group is owned by identity", async () => {
  const extra = pausedWithData();
  const later: HeldPipes[] = [];
  expect(await closePipesAfterExit(child, [{ name: "extra", stream: extra }], 20, (held) => { later.push(held); }, 300)).toBeUndefined();
  expect(ownLeftProcesses).not.toHaveBeenCalled();
  await delay(400);
  expect(vi.mocked(ownLeftProcesses).mock.calls).toEqual([[child, [member]]]);
  // Taken now, past the limit: OAR no longer looks, so the pipe stays the reader's.
  extra.resume();
  await delay(300);
  expect({ open: !extra.destroyed, unread: extra.readableLength, later, owned: vi.mocked(ownLeftProcesses).mock.calls.length })
    .toEqual({ open: true, unread: 0, later: [], owned: 1 });
  extra.destroy();
});

test.skipIf(!posix)("a pipe its reader closes while it is left to it ends the recheck without owning anything", async () => {
  const extra = pausedWithData();
  const later: HeldPipes[] = [];
  expect(await closePipesAfterExit(child, [{ name: "extra", stream: extra }], 20, (held) => { later.push(held); }, 300)).toBeUndefined();
  extra.destroy();
  await delay(400);
  expect({ later, owned: vi.mocked(ownLeftProcesses).mock.calls.length }).toEqual({ later: [], owned: 0 });
});
