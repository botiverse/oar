import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { alive, signalFixture, reportedProcess, type ProcessIdentity } from "../fixtures/process-tree.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { killedHost } from "../fixtures/cursor-killed-host.js";
import { bundled, fakeCursorRuntime, responsesOf, tempDirectory, until } from "../fixtures/cursor-subprocess.js";

/*
 * A tool command's background job (`sleep 300 &`) outlives its shell: once
 * the shell exited it is reparented (to PID 1 or a subreaper), in the dead shell's process
 * group, so neither a parent-pid walk nor a group kill finds it. What finds
 * it is the environment marker every process the child starts inherits
 * (environment-marker.ts): on Linux the child scans for it as it exits, and
 * the host after the child exited, whatever ended it. Linux only, the one
 * platform with a marker scan.
 */

const linux = process.platform === "linux";
const leftovers: ProcessIdentity[] = [];

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    signalFixture(pid);
  }
});

function sleepIdentity(file: string): ProcessIdentity {
  const pid = reportedProcess(JSON.parse(readFileSync(file, "utf8")));
  leftovers.push(pid);
  return pid;
}

/** Has the session's run start a shell that backgrounds a sleep and exits; the sleep's pid. */
async function backgroundJob(session: Session, how: "background" | "background-unmarked"): Promise<ProcessIdentity> {
  const file = path.join(tempDirectory(), "sleep.pid");
  const prompt = await session.prompt(`${how}:${file}`);
  await awaitTurnEnd(session, prompt.seq);
  return sleepIdentity(file);
}

test.runIf(linux)("dispose ends a tool's background job that outlived its shell", async () => {
  const session = await fakeCursorRuntime("subprocess").session(bundled, { cwd: tempDirectory() });
  const sleep = await backgroundJob(session, "background");
  expect(alive(sleep)).toBe(true);
  await session.dispose();
  await until(() => !alive(sleep));
  expect(alive(sleep)).toBe(false);
});

test.runIf(linux).each(["inherit", "clean"] as const)("a child SIGKILLed after such a job leaves nothing: the host ends the job (%s)", async (envBase) => {
  const env = envBase === "clean" ? { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } : {};
  const session = await fakeCursorRuntime("subprocess", envBase).session(bundled, { cwd: tempDirectory(), env });
  const sleep = await backgroundJob(session, "background");
  const prompt = await session.prompt("crash");
  await awaitTurnEnd(session, prompt.seq);
  await until(() => responsesOf(session, "exited").length > 0);
  await until(() => !alive(sleep));
  expect(alive(sleep)).toBe(false);
  await session.dispose();
});

test.runIf(linux).each(["inherit", "clean"] as const)("a SIGKILLed host's child ends such a job (%s)", async (envBase) => {
  const dir = tempDirectory();
  const file = path.join(dir, "sleep.pid");
  const host = killedHost(dir, file, { how: "background", envBase });
  expect(host.signal).toBe("SIGKILL");
  const sleep = sleepIdentity(file);
  await until(() => !alive(sleep), 10_000);
  expect(alive(sleep)).toBe(false);
});

test.runIf(linux)("negative control: a job started without the marker is not found, and outlives dispose", async () => {
  const session = await fakeCursorRuntime("subprocess").session(bundled, { cwd: tempDirectory() });
  const sleep = await backgroundJob(session, "background-unmarked");
  await session.dispose();
  // Long enough for every scan to have run: the dispose waited for the child's exit and the host's own scan.
  expect(alive(sleep)).toBe(true);
});
