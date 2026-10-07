import { expect, test } from "vitest";
import type { RawEvent, RequestBody, Session, TurnOutcome } from "../packages/oar/src/contracts/session.js";
import { initialStatus, reduceStatus, statusOf } from "../packages/oar/src/observe/agent-status.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";
import { awaitTurnEnd, promptAndWait, turnEndAfter } from "../packages/oar/src/observe/turns.js";
import { createSessionKernel, type SessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { sealSession } from "../packages/oar/src/shared/seal-session.js";

const ROOT = "root";
type Stop = "accepted" | "rejected" | "dispose" | "none";
const cases: readonly Stop[] = ["accepted", "rejected", "dispose", "none"];
const failed: TurnOutcome = { kind: "failed", reason: "runtime exited", failure: "runtime_exited" };
const outcomeFor = (stop: Stop): TurnOutcome => stop === "accepted" || stop === "dispose" ? { kind: "aborted" } : failed;

function respondToStop(kernel: SessionKernel, stop: Stop): void {
  if (stop === "none") { return; }
  const request = kernel.request("toRuntime", { kind: stop === "dispose" ? "dispose" : "abort" });
  if (stop !== "dispose") {
    kernel.respond(request.id, stop === "accepted" ? { kind: "accepted" } : { kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
  }
}

function start(kernel: SessionKernel): number {
  const request = kernel.request("toRuntime", { kind: "prompt", input: "work" });
  kernel.respond(request.id, { kind: "accepted" });
  kernel.frame({ type: "text", native: {}, events: [{ kind: "text_delta", text: "partial" }] });
  return request.seq;
}

function fixture(): { kernel: SessionKernel; session: Session } {
  const kernel = createSessionKernel(ROOT);
  const control = async (body: RequestBody): Promise<Awaited<ReturnType<SessionKernel["control"]>>> =>
    kernel.control(body, () => ({ kind: "accepted" }));
  const session = sealSession({
    id: ROOT,
    capabilities: { queue: { durable: false }, attribution: "nested", images: false },
    prompt: async (input) => control({ kind: "prompt", input }),
    queue: async (input) => control({ kind: "queue", input }),
    abort: async () => control({ kind: "abort" }),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => { respondToStop(kernel, "dispose"); kernel.respond("", { kind: "exited", code: 9 }); },
  });
  return { kernel, session };
}

function assertFolds(records: readonly RawEvent[], afterSeq: number, expected: TurnOutcome): void {
  expect(statusOf(records, ROOT).value).toEqual({ kind: "idle", lastTurnOutcome: expected });
  expect(turnEndAfter(records, afterSeq, ROOT)).toEqual(expected);
  const view = viewOf(records);
  expect(view.status).toEqual({ kind: "idle", lastTurnOutcome: expected });
  expect(view.messages.findLast((message) => message.kind === "turn")?.outcome).toEqual(expected);
  expect(view.exited).toMatchInlineSnapshot(`
    {
      "code": 9,
    }
  `);
}

test.each(cases)("exit after %s: status, turn helpers and session view agree in replay and live", async (stop) => {
  const { kernel, session } = fixture();
  const afterSeq = start(kernel);
  const waiting = awaitTurnEnd(session, afterSeq);
  respondToStop(kernel, stop);
  // Unrelated runtime activity between the stop and exit must preserve it.
  kernel.frame({ type: "reasoning", native: {}, events: [{ kind: "reasoning", content: { kind: "text", text: "still running" } }] });
  kernel.respond("", { kind: "exited", code: 9 });
  const expected = outcomeFor(stop);
  assertFolds(kernel.records(), afterSeq, expected);
  expect(await waiting).toEqual(expected);
  expect(await awaitTurnEnd(session, afterSeq)).toEqual(expected);
});

// oxlint-disable-next-line eslint/max-statements -- Observe the full request, response and exit sequence in one fixture.
test.each(cases)("promptAndWait observes exit after %s", async (stop) => {
  const { kernel, session } = fixture();
  const ended = promptAndWait({
    ...session,
    abort: async () => {
      const request = kernel.request("toRuntime", { kind: "abort" });
      const response = kernel.respond(request.id, stop === "accepted"
        ? { kind: "accepted" }
        : { kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
      kernel.respond("", { kind: "exited", code: 9 });
      return { request, response, seq: request.seq, requestId: request.id, ...(stop === "accepted"
        ? { kind: "accepted" } as const
        : { kind: "rejected", code: "runtime_exited", reason: "runtime exited" } as const) };
    },
  }, "work", stop === "accepted" || stop === "rejected" ? { signal: AbortSignal.abort() } : {});
  if (stop === "dispose") { await session.dispose(); }
  if (stop === "none") { kernel.respond("", { kind: "exited", code: 9 }); }
  const result = await ended;
  expect(result.kind).toBe(stop === "accepted" ? "interrupted" : "ended");
  if (result.kind === "rejected") { throw new Error("prompt was unexpectedly rejected"); }
  expect(result.outcome).toEqual(outcomeFor(stop));
});

test("an unanswered abort, an unmatched acceptance and a non-abort acceptance do not mark an exit aborted", () => {
  const { kernel } = fixture();
  const afterSeq = start(kernel);
  kernel.request("toRuntime", { kind: "abort" });
  kernel.respond("unrelated", { kind: "accepted" });
  const queue = kernel.request("toRuntime", { kind: "queue", input: "later" });
  kernel.respond(queue.id, { kind: "accepted" });
  kernel.respond("", { kind: "exited", code: 9 });
  assertFolds(kernel.records(), afterSeq, failed);
});

test("stop state survives a serialized incremental status checkpoint and a later refused abort", () => {
  const { kernel } = fixture();
  const afterSeq = start(kernel);
  respondToStop(kernel, "accepted");
  respondToStop(kernel, "rejected");
  let status = initialStatus;
  for (const record of kernel.records()) {
    status = reduceStatus(structuredClone(status), record, ROOT);
  }
  const exit = kernel.respond("", { kind: "exited", code: 9 });
  expect(reduceStatus(structuredClone(status), exit, ROOT)).toMatchInlineSnapshot(`
    {
      "kind": "idle",
      "lastTurnOutcome": {
        "kind": "aborted",
      },
    }
  `);
  assertFolds(kernel.records(), afterSeq, { kind: "aborted" });
});

// oxlint-disable-next-line eslint/max-statements -- Observe the full request, response and exit sequence in one fixture.
test.each(["accepted", "pending"])("a previous turn's %s abort never stops the next turn", async (answer) => {
  const { kernel, session } = fixture();
  start(kernel);
  const old = kernel.request("toRuntime", { kind: "abort" });
  if (answer === "accepted") { kernel.respond(old.id, { kind: "accepted" }); }
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  const afterSeq = start(kernel);
  if (answer === "pending") { kernel.respond(old.id, { kind: "accepted" }); }
  kernel.respond("", { kind: "exited", code: 9 });
  assertFolds(kernel.records(), afterSeq, failed);
  expect(await awaitTurnEnd(session, afterSeq)).toEqual(failed);
});

// oxlint-disable-next-line eslint/max-statements -- Observe the full request, response and exit sequence in one fixture.
test.each([{ sessionId: "child" }, { agentPath: ["child"] }])("child stop and exit do not change the root: %j", async (scope) => {
  const { kernel, session } = fixture();
  const afterSeq = start(kernel);
  const waiting = awaitTurnEnd(session, afterSeq);
  const stop = kernel.request("toRuntime", { kind: "dispose" }, scope);
  kernel.respond(stop.id, { kind: "exited", code: 0 }, scope);
  expect(session.status().value.kind).toBe("running");
  expect(turnEndAfter(kernel.records(), afterSeq, ROOT)).toBeNull();
  expect(viewOf(kernel.records()).openTurn).not.toBe(-1);
  kernel.respond("", { kind: "exited", code: 9 });
  assertFolds(kernel.records(), afterSeq, failed);
  expect(await waiting).toEqual(failed);
});

test.each(["accepted", "dispose"] as const)("a native completion before exit wins over %s stop intent", async (stop) => {
  const { kernel, session } = fixture();
  const afterSeq = start(kernel);
  const waiting = awaitTurnEnd(session, afterSeq);
  respondToStop(kernel, stop);
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
  kernel.respond("", { kind: "exited", code: 9 });
  assertFolds(kernel.records(), afterSeq, { kind: "completed" });
  expect(await waiting).toMatchInlineSnapshot(`
    {
      "kind": "completed",
    }
  `);
});

test.each(["accepted", "dispose"] as const)("turn helpers retain %s stop evidence before the supplied cursor", async (stop) => {
  const { kernel, session } = fixture();
  start(kernel);
  respondToStop(kernel, stop);
  const cursor = kernel.records().at(-1)?.seq ?? -1;
  const waiting = awaitTurnEnd(session, cursor);
  kernel.respond("", { kind: "exited", code: 9 });
  assertFolds(kernel.records(), cursor, { kind: "aborted" });
  expect(await waiting).toMatchInlineSnapshot(`
    {
      "kind": "aborted",
    }
  `);
});
