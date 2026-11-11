import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { alive, bundled, fakeCursorRuntime, reportedPids, responsesOf, tempDirectory, until, type CursorMode } from "../fixtures/cursor-subprocess.js";

/*
 * What only the subprocess mode has: a crash recorded as `exited`, dispose
 * answered with the child's exit after the SDK's own close work, and the
 * child's whole tree ended. The fake's tool (`spawn:`) leads a process group
 * of its own, as SDK 1.3.1 starts its shell tool on POSIX; `spawn-in-group:`
 * keeps it in the child's group.
 */

async function open(mode: CursorMode, env: Readonly<Record<string, string>> = {}): Promise<Session & Required<Pick<Session, "steer">>> {
  const session = await fakeCursorRuntime(mode).session(bundled, { cwd: tempDirectory(), model: "composer", env });
  if (session.steer === undefined) { throw new Error("a cursor session steers"); }
  return { ...session, steer: session.steer.bind(session) };
}

function frameTypes(session: Session): string[] {
  return session.records().flatMap((record) => (record.kind === "frame" ? [record.body.type] : []));
}

/** Has the session's run start a tool (`spawn` or `spawn-in-group`), and returns the child's and the tool's pids. */
async function startTool(session: Session, how: "spawn" | "spawn-in-group"): Promise<{ readonly child: number; readonly grandchild: number }> {
  const file = path.join(tempDirectory(), "pids.json");
  const prompt = await session.prompt(`${how}:${file}`);
  await awaitTurnEnd(session, prompt.seq);
  return reportedPids(file);
}

async function gone(pids: { readonly child: number; readonly grandchild: number }): Promise<{ readonly child: boolean; readonly grandchild: boolean }> {
  await until(() => !alive(pids.child) && !alive(pids.grandchild));
  return { child: !alive(pids.child), grandchild: !alive(pids.grandchild) };
}

test("in process, dispose is answered accepted; in a child, by the child's exit", async () => {
  const inProcess = await open("in_process");
  await inProcess.dispose();
  expect(responsesOf(inProcess, "accepted").at(-1)).toEqual({ kind: "accepted" });
  const child = await open("subprocess");
  await child.dispose();
  expect(responsesOf(child, "exited")).toEqual([{ kind: "exited", code: 0 }]);
  const after = await child.prompt("echo:after");
  expect(after.response.body).toMatchObject({ kind: "rejected", code: "runtime_exited" });
});

test("dispose waits for the SDK's own close work (Symbol.asyncDispose) before the child exits", async () => {
  const closed = path.join(tempDirectory(), "closed");
  const session = await open("subprocess", { OAR_FAKE_CURSOR_CLOSED: closed });
  await session.dispose();
  expect(existsSync(closed)).toBe(true);
});

test.each(["spawn", "spawn-in-group"] as const)("dispose ends the child's tool too (%s)", async (how) => {
  const session = await open("subprocess");
  const pids = await startTool(session, how);
  await session.dispose();
  expect(await gone(pids)).toEqual({ child: true, grandchild: true });
});

// oxlint-disable-next-line eslint/max-statements -- the crash, its records, each later control and the tool, in order.
test("a child SIGKILLed mid-run is recorded as exited, ends the turn, refuses later prompts, and its in-group tool ends", async () => {
  const session = await open("subprocess");
  const pids = await startTool(session, "spawn-in-group");
  const prompt = await session.prompt("crash");
  const outcome = await awaitTurnEnd(session, prompt.seq);
  expect(outcome).toMatchObject({ kind: "failed", reason: "cursor's SDK child process exited with signal SIGKILL" });
  expect(responsesOf(session, "exited")).toEqual([{ kind: "exited", code: null, reason: "cursor's SDK child process exited with signal SIGKILL" }]);
  expect(frameTypes(session)).toContain("cursor/run_failed");
  expect(session.status().value.kind).toBe("idle");
  const again = await session.prompt("echo:again");
  const steer = await session.steer("too late");
  expect([again.response.body, steer.response.body]).toMatchObject([{ kind: "rejected", code: "runtime_exited" }, { kind: "rejected", code: "runtime_exited" }]);
  await session.dispose();
  expect(responsesOf(session, "exited")).toHaveLength(1);
  expect(await gone(pids)).toEqual({ child: true, grandchild: true });
});

test("a child that dies of an uncaught exception ends its tool that leads its own group, and the stderr is in the reason", async () => {
  const session = await open("subprocess");
  const pids = await startTool(session, "spawn");
  const prompt = await session.prompt("throw");
  await awaitTurnEnd(session, prompt.seq);
  const [exited] = responsesOf(session, "exited");
  expect(exited).toMatchObject({ kind: "exited", code: 1 });
  expect(JSON.stringify(exited)).toContain("fake SDK failure");
  expect(await gone(pids)).toEqual({ child: true, grandchild: true });
  await session.dispose();
});

test("a child that dies while dispose cancels its run answers that dispose, with the crash's reason", async () => {
  const session = await open("subprocess");
  await session.prompt("crash-on-cancel");
  await session.dispose();
  const dispose = session.records().flatMap((record) => (record.kind === "request" && record.body.kind === "dispose" ? [record.id] : []));
  expect(dispose).toHaveLength(1);
  const answers = session.records().flatMap((record) => (record.kind === "response" && record.requestId === dispose[0] ? [record.body] : []));
  expect(answers).toEqual([{ kind: "exited", code: null, reason: "cursor's SDK child process exited with signal SIGKILL" }]);
});
