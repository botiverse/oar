import { expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { bundled, fakeCursorRuntime, lastResult, tempDirectory, until, type CursorMode } from "../fixtures/cursor-subprocess.js";

/*
 * The same session tests in both execution modes, over the same fake SDK
 * module: in process (`sdk: () => module`) and in a child per session
 * (`sdkModule`). What only the subprocess mode has (crash, dispose, the
 * child's tree) is in cursor-subprocess-lifecycle.test.ts.
 */

const modes: readonly CursorMode[] = ["in_process", "subprocess"];

async function open(mode: CursorMode): Promise<Session & Required<Pick<Session, "steer">>> {
  const session = await fakeCursorRuntime(mode).session(bundled, { cwd: tempDirectory(), model: "composer" });
  if (session.steer === undefined) { throw new Error("a cursor session steers"); }
  return { ...session, steer: session.steer.bind(session) };
}

function frameTypes(session: Session): string[] {
  return session.records().flatMap((record) => (record.kind === "frame" ? [record.body.type] : []));
}

// oxlint-disable-next-line eslint/max-statements -- one run, asserted end to end.
test.each(modes)("%s: a prompt is one run; its deltas, stream and result are frames, and its usage counts", async (mode) => {
  const session = await open(mode);
  try {
    expect(session.placement).toBe(mode === "subprocess" ? "isolated" : "in_process");
    const prompt = await session.prompt("echo:PELICAN");
    expect(prompt.response.body).toEqual({ kind: "accepted", native: { runId: "run-1" } });
    expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
    expect(frameTypes(session)).toEqual(["cursor/agent_opened", "text-delta", "turn-ended", "cursor/stream/assistant", "cursor/run_result"]);
    expect(lastResult(session)).toBe("PELICAN");
    expect(session.usage().value.total).toEqual({ input: 10, output: 2, cacheRead: 5, cacheWrite: 0 });
    expect(session.model().value).toBe("composer-2.5");
  } finally {
    await session.dispose();
  }
});

test.each(modes)("%s: a steer is taken and echoed; abort cancels the run and its cancelled status ends the turn", async (mode) => {
  const session = await open(mode);
  try {
    const prompt = await session.prompt("hold");
    const steer = await session.steer("also PELICAN");
    expect(steer.response.body).toEqual({ kind: "accepted", native: { ack: "complete_delivered" } });
    const abort = await session.abort();
    expect(abort.response.body).toEqual({ kind: "accepted" });
    expect(await awaitTurnEnd(session, prompt.seq)).toMatchObject({ kind: "aborted" });
    expect(frameTypes(session)).toContain("user-message-appended");
  } finally {
    await session.dispose();
  }
});

test.each(modes)("%s: queued input waits for the run to end, then runs as its own turn", async (mode) => {
  const session = await open(mode);
  try {
    const first = await session.prompt("hold");
    const queued = await session.queue("echo:later");
    expect(queued.response.body).toMatchObject({ kind: "accepted" });
    await session.abort();
    await awaitTurnEnd(session, first.seq);
    await until(() => lastResult(session) === "later");
    expect(lastResult(session)).toBe("later");
  } finally {
    await session.dispose();
  }
});
