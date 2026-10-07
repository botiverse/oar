import { afterEach, expect, test, vi } from "vitest";
import type { RawEvent } from "../../packages/oar/src/contracts/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import { steer } from "../fixtures/steer.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.268" } as const;

afterEach(() => {
  spawnLineProcess.mockReset();
  vi.useRealTimers();
});

function describe(record: RawEvent): string {
  switch (record.kind) {
    case "frame":
      return `event ${record.body.type}`;
    case "request":
      return `request ${record.body.kind}`;
    case "response":
      return record.body.kind === "exited"
        ? `response exited code=${String(record.body.code)} for=${JSON.stringify(record.requestId)}`
        : `response ${record.body.kind}`;
    default:
      return "?";
  }
}

// Pinned live on claude 2.1.268 (experiments/live-contract.ts kill-runtime,
// 2026-09-11): SIGKILL mid-turn yields an `exited` response pointing at no
// request, the turn ends as runtime_exited for observers, and every later
// control is rejected: a dead stdin must never take input over.
async function killedMidTurn(): Promise<{ session: Awaited<ReturnType<typeof claudeSession>>; promptSeq: number }> {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  const started = await session.prompt("run something long");
  expect(started.response.body.kind).toBe("accepted");
  fake.end(null);
  return { session, promptSeq: started.request.seq };
}

test("an unrequested exit is recorded as an exit pointing at no request and ends the turn for observers", async () => {
  const { session, promptSeq } = await killedMidTurn();
  const last = session.records().at(-1);
  expect(last === undefined ? "none" : describe(last)).toBe('response exited code=null for=""');
  expect(await awaitTurnEnd(session, promptSeq)).toEqual({ kind: "failed", reason: "runtime exited", failure: "runtime_exited" });
  await session.dispose();
});

test("after an unrequested exit every control is rejected and a later dispose is answered", async () => {
  const { session } = await killedMidTurn();
  const bodies = await Promise.all([session.prompt("again"), steer(session, "x"), session.queue("y"), session.abort()]);
  expect(bodies.map((result) => result.response.body)).toEqual(Array.from({ length: 4 }, () => ({ kind: "rejected", code: "runtime_exited", reason: "runtime exited" })));
  await session.dispose();
  expect(session.records().slice(-2).map((record) => describe(record))).toEqual(["request dispose", "response accepted"]);
});


// oxlint-disable-next-line eslint/max-statements -- Assert the exit and late-reply ordering in one session.
test("exit settles every unanswered interrupt once; a late control_response is only a frame", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  const prompt = await session.prompt("hold");
  const aborts = [session.abort(), session.abort()];
  const ids = session.records().flatMap((record) => record.kind === "request" && record.body.kind === "abort" ? [record.id] : []);
  fake.end(9);
  for (const id of ids) {
    expect(session.records().filter((record) => record.kind === "response" && record.requestId === id))
      .toMatchObject([{ body: { kind: "rejected", code: "runtime_exited" } }]);
    // Node's exit event can precede the last data event on stdout.
    const late = { type: "control_response", response: { subtype: "success", request_id: id } };
    fake.stdout.emit("data", `${JSON.stringify(late)}\n`);
    expect(session.records().filter((record) => record.kind === "response" && record.requestId === id)).toHaveLength(1);
    expect(session.records().at(-1)).toMatchObject({ kind: "frame", body: { type: "control_response", native: late, events: [] } });
  }
  const settled = await Promise.all(aborts);
  expect(settled.map((result) => result.response.body)).toEqual([
    { kind: "rejected", code: "runtime_exited", reason: "runtime exited" },
    { kind: "rejected", code: "runtime_exited", reason: "runtime exited" },
  ]);
  expect(await awaitTurnEnd(session, prompt.request.seq)).toMatchObject({ failure: "runtime_exited" });
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- Assert the deadline and its recorded outcome on the same active turn.
test.each([false, true])("a stuck aborted turn is killed even when interrupt was acknowledged: %s", async (acknowledge) => {
  vi.useFakeTimers();
  const fake = fakeLineProcess((text, child) => {
    const message = asRecord(parseJson(text));
    if (acknowledge && message?.type === "control_request") {
      child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id } })}\n`);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  const prompt = await session.prompt("hold");
  const liveEnd = awaitTurnEnd(session, prompt.request.seq);
  const abort = session.abort();
  await vi.advanceTimersByTimeAsync(5000);
  const repeated = session.abort();
  await vi.advanceTimersByTimeAsync(4999);
  expect(fake.killed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.killed()).toBe(true);
  const result = await abort;
  await repeated;
  expect(result.response.body).toMatchObject({ kind: "accepted" });
  expect(session.records().filter((record) => record.kind === "response" && record.requestId === result.request.id)).toHaveLength(1);
  expect(session.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(true);
  expect(await liveEnd).toMatchInlineSnapshot(`
    {
      "kind": "aborted",
    }
  `);
  expect(await awaitTurnEnd(session, prompt.request.seq)).toMatchInlineSnapshot(`
    {
      "kind": "aborted",
    }
  `);
  await session.dispose();
});


// oxlint-disable-next-line eslint/max-statements -- Pin timer cancellation across two successive turns.
test("a completed turn cancels the abort deadline before another turn starts", async () => {
  vi.useFakeTimers();
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  await session.prompt("first");
  const abort = session.abort();
  fake.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "interrupt-1" } })}\n`);
  await abort;
  fake.emit(`${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`);
  await session.prompt("next");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fake.killed()).toBe(false);
  await session.dispose();
});


// A later refused attempt must not cancel an earlier accepted interrupt's fallback.
// oxlint-disable-next-line eslint/max-statements -- Compare the outcomes of two native replies on the same turn.
test.each([false, true])("a refused interrupt cancels only its own deadline attempt; earlier accepted: %s", async (earlierAccepted) => {
  vi.useFakeTimers();
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  await session.prompt("hold");
  const first = session.abort();
  fake.emit(`${JSON.stringify({ type: "control_response", response: {
    subtype: earlierAccepted ? "success" : "error", request_id: "interrupt-1",
  } })}\n`);
  await first;
  const second = session.abort();
  fake.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "interrupt-2" } })}\n`);
  await second;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fake.killed()).toBe(earlierAccepted);
  await session.dispose();
});
