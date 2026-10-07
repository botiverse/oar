import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { descendantsOf, killEntries, readProcessTable, type ProcessEntry } from "../packages/oar/src/shared/executable/process-tree.js";
import { eventually, gone } from "./fixtures/process-tree.js";

const posix = process.platform !== "win32";
const SLEEP = ["-e", "setTimeout(() => {}, 60000)"];
// A leader in a session of its own that reports a member of its group: a process only the group signal reaches.
const LEADER = String.raw`
  const member = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  member.once("spawn", () => { process.stdout.write(member.pid + "\n"); });
  setTimeout(() => {}, 60000);
`;

/** A Node process sleeping for a minute; `detached` puts it in a session of its own. */
function sleeper(options: { readonly detached?: boolean; readonly command?: string } = {}): ChildProcess {
  return spawn(options.command ?? process.execPath, SLEEP, { stdio: "ignore", detached: options.detached === true });
}

/** Run `body` with the children started; SIGKILL them (and `extra` pids) afterwards. */
async function withChildren(children: readonly ChildProcess[], body: (pids: readonly number[], extra: number[]) => Promise<void>): Promise<void> {
  const extra: number[] = [];
  try {
    await Promise.all(children.map(async (child) => once(child, "spawn")));
    await body(children.map((child) => child.pid ?? 0), extra);
  } finally {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    for (const pid of extra) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ }
    }
  }
}

function entry(pid: number, ppid: number): ProcessEntry {
  return { pid, ppid, pgid: pid, start: "0" };
}

const byNumber = (left: number, right: number): number => left - right;

test("descendantsOf finds children and theirs, nothing above or beside, and ends on a cycle", () => {
  const table = new Map([
    entry(10, 1), entry(11, 10), entry(12, 10), entry(13, 12), entry(20, 1), entry(21, 20),
    // A table read across a pid reuse can loop; the walk still ends.
    entry(30, 31), entry(31, 30),
  ].map((process) => [process.pid, process] as const));
  assert.deepEqual(descendantsOf(table, 10).map(({ pid }) => pid).toSorted(byNumber), [11, 12, 13]);
  assert.deepEqual(descendantsOf(table, 13), []);
  assert.deepEqual(descendantsOf(table, 30).map(({ pid }) => pid), [31]);
  assert.deepEqual(descendantsOf(table, 99), []);
});

const sources = process.platform === "linux" ? (["procfs", "ps"] as const) : (["ps"] as const);
test.skipIf(!posix).each(sources)("%s shows this process, its parent, and children it just started", async (source) => {
  await withChildren([sleeper(), sleeper({ detached: true })], async ([attached = 0, detached = 0]) => {
    const table = readProcessTable(source);
    const [host, child, session] = [table.get(process.pid), table.get(attached), table.get(detached)];
    assert.ok(host !== undefined && child !== undefined && session !== undefined, "all three are in the table");
    assert.equal(host.ppid, process.ppid);
    assert.deepEqual([child.ppid, child.pgid], [process.pid, host.pgid], "the attached child shares this process's group");
    // A session of its own: it leads a group of its own.
    assert.deepEqual([session.ppid, session.pgid], [process.pid, detached], "the detached child leads its own");
    const below = new Set(descendantsOf(table, process.pid).map(({ pid }) => pid));
    assert.ok(below.has(attached) && below.has(detached), "both are found below this process");
    // The start time names the process: the same in a second read.
    assert.equal(readProcessTable(source).get(attached)?.start, child.start);
  });
});

test.skipIf(process.platform !== "linux")("procfs reads a command name holding spaces and parentheses", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-process-tree-"));
  try {
    const command = path.join(dir, "a) (b c");
    symlinkSync(process.execPath, command);
    await withChildren([sleeper({ command })], async ([pid = 0]) => {
      assert.ok(await eventually(() => readProcessTable("procfs").get(pid)?.ppid === process.pid, 2000), "its parent is read past the name");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!posix)("killEntries spares a pid whose start time differs: it may be another process by now", async () => {
  await withChildren([sleeper({ detached: true })], async ([pid = 0]) => {
    const table = readProcessTable();
    const current = table.get(pid);
    assert.ok(current !== undefined);
    killEntries([{ ...current, start: `${current.start}-earlier` }], table);
    assert.equal(await gone(pid, 300), false, "a different start time is not signalled");
    killEntries([current], readProcessTable());
    assert.equal(await gone(pid), true, "the same process is");
  });
});

test.skipIf(!posix)("killEntries takes each entry's process group too, never the host or its group", async () => {
  const leader = spawn(process.execPath, ["-e", LEADER], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  const reported = once(leader.stdout, "data");
  await withChildren([leader, sleeper(), sleeper()], async ([leaderPid = 0, target = 0, sibling = 0], extra) => {
    const data: unknown[] = await reported;
    const member = Number(String(data[0]));
    extra.push(member);
    const table = readProcessTable();
    const [host, leaderEntry, targetEntry] = [table.get(process.pid), table.get(leaderPid), table.get(target)];
    assert.ok(host !== undefined && leaderEntry !== undefined && targetEntry !== undefined);
    assert.deepEqual([targetEntry.pgid, table.get(member)?.pgid], [host.pgid, leaderPid], "an attached sleeper shares the host's group; the member is in the leader's");
    killEntries([host, leaderEntry, targetEntry], table);
    assert.deepEqual([await gone(leaderPid), await gone(member), await gone(target)], [true, true, true], "the entries and the leader's group go");
    assert.equal(await gone(sibling, 300), false, "the host's group is not signalled");
  });
});
