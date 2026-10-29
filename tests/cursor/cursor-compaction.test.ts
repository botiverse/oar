/* oxlint-disable eslint/max-statements -- each race is driven and checked as one complete run. */
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { FakeCursorRun, openFakeCursor } from "../fixtures/fake-cursor-sdk.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const summary = (status: string, extra = {}) => ({ type: "summary", agent_id: "agent-1", run_id: "run-1", status, ...extra });

test.each([
  ["completed", {}, "completed"],
  ["completed", { fallback: true }, "completed"],
  ["error", {}, "failed"],
] as const)("Cursor summary %s %j is independent of the run outcome", async (status, extra, outcome) => {
  const { session, agent } = await openFakeCursor();
  const prompt = await session.prompt("work");
  const run = agent.latest();
  const started = summary("running");
  const ended = summary(status, extra);
  run.streamMessage(started);
  await settle();
  expect(session.status().value).toMatchObject({ kind: "running", phase: "compacting" });
  run.streamMessage(ended);
  run.end("finished");
  expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
  const frames = session.records().flatMap((record) => record.kind === "frame" && record.body.type === "cursor/stream/summary" ? [record.body] : []);
  expect(frames).toEqual([
    { type: "cursor/stream/summary", native: started, events: [{ kind: "compaction_started" }] },
    { type: "cursor/stream/summary", native: ended, events: [{ kind: "compaction_ended", outcome }] },
  ]);
  expect(run.streamDrained).toBe(true);
  await session.dispose();
});

test("wait settling first does not drain queued input before the final summary", async () => {
  const { session, agent } = await openFakeCursor();
  const prompt = await session.prompt("first");
  await session.queue("second");
  const run = agent.latest();
  run.holdStream = true;
  run.streamMessage(summary("running"));
  run.end("finished");
  await settle();
  expect(agent.runs).toHaveLength(1);
  run.streamMessage(summary("completed"));
  run.closeStream();
  await awaitTurnEnd(session, prompt.seq);
  await settle();
  expect(agent.runs).toHaveLength(2);
  const kinds = session.records().flatMap((record) => record.kind === "frame" ? record.body.events.map((event) => event.kind) : []);
  expect(kinds.indexOf("compaction_ended")).toBeLessThan(kinds.indexOf("turn_ended"));
  await session.dispose();
});

test.each(["message", "error"] as const)("an unclosed stream cannot hold a finished run or leak a late %s into the next turn", async (late) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const release = Promise.withResolvers<void>();
  const iterator = (async function* delayedSummary() {
    yield summary("running");
    await release.promise;
    if (late === "error") { throw new Error("late stream failure"); }
    yield summary("completed");
  })();
  const next = vi.spyOn(iterator, "next");
  const close = vi.spyOn(iterator, "return");
  vi.spyOn(FakeCursorRun.prototype, "stream").mockReturnValueOnce(iterator);
  const { session, agent } = await openFakeCursor();
  const prompt = await session.prompt("first");
  await session.queue("second");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(agent.runs).toHaveLength(1);
  expect(close).not.toHaveBeenCalled();
  agent.latest().end("finished");
  await vi.advanceTimersByTimeAsync(1900);
  expect(agent.runs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(agent.runs).toHaveLength(2);
  expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
  expect(close).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(2);
  const frames = session.records().flatMap((record) => record.kind === "frame" ? [record.body] : []);
  expect(frames.filter((frame) => frame.type === "cursor/stream_unclosed")).toEqual([
    { type: "cursor/stream_unclosed", native: { timeoutMs: 2000 }, events: [] },
  ]);
  expect(frames.findIndex((frame) => frame.type === "cursor/stream_unclosed")).toBeLessThan(frames.findIndex((frame) => frame.type === "cursor/run_result"));
  expect(frames.flatMap((frame) => frame.events).filter((event) => event.kind.startsWith("compaction_"))).toEqual([{ kind: "compaction_started" }]);
  agent.latest().delta({ type: "thinking-delta", text: "second turn" });
  const retained = [...session.records()];
  release.resolve();
  await settle();
  expect(session.records()).toEqual(retained);
  expect(next).toHaveBeenCalledTimes(2);
  expect(session.status().value).toMatchObject({ kind: "running", phase: "thinking" });
  await session.dispose();
});

test("the second view retains messages without duplicating text, tools or usage events", async () => {
  const { session, agent } = await openFakeCursor();
  const prompt = await session.prompt("work");
  const run = agent.latest();
  const deltas = [
    { type: "text-delta", text: "hello" },
    { type: "tool-call-started", callId: "read-1", toolCall: { type: "read", args: { path: "x" } } },
    { type: "turn-ended", usage: { inputTokens: 5, outputTokens: 2 } },
  ];
  const messages = [{ type: "assistant", text: "hello" }, { type: "tool_call", call_id: "read-1" }, { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } }, summary("future-status")];
  for (const delta of deltas) { run.delta(delta); }
  for (const message of messages) { run.streamMessage(message); }
  run.end("finished");
  await awaitTurnEnd(session, prompt.seq);
  const frames = session.records().flatMap((record) => record.kind === "frame" ? [record.body] : []);
  expect(frames.filter((frame) => frame.type.startsWith("cursor/stream/")).map((frame) => frame.native)).toEqual(messages);
  expect(frames.flatMap((frame) => frame.events).filter((event) => ["text_delta", "tool_call_started", "usage"].includes(event.kind))).toHaveLength(3);
  expect(frames.filter((frame) => deltas.some((delta) => delta === frame.native))).toHaveLength(3);
  await session.dispose();
});

test("an iterator error is redacted without replacing a successful native run result", async () => {
  const { session, agent } = await openFakeCursor();
  const prompt = await session.prompt("work");
  const run = agent.latest();
  run.streamMessage(summary("running"));
  run.closeStream(new Error("stream buffer overflow: sk-test-secret-not-for-retention eyJhbGciOi.test.signature\nprivate log tail"));
  await settle();
  run.end("finished");
  expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "completed" });
  expect(session.records().flatMap((record) => record.kind === "frame" && record.body.type === "cursor/stream_failed" ? [record.body] : [])).toEqual([
    { type: "cursor/stream_failed", native: { message: "stream buffer overflow: [redacted] [redacted]" }, events: [] },
  ]);
  expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []).some((event) => event.kind === "compaction_ended")).toBe(false);
  await session.dispose();
});

test.each(["abort", "dispose", "failure"] as const)("%s after a summary starts does not invent a compaction outcome", async (action) => {
  const { session, agent } = await openFakeCursor();
  const prompt = await session.prompt("work");
  const run = agent.latest();
  run.streamMessage(summary("running"));
  await settle();
  if (action === "failure") { run.fail(new Error("native run failure")); }
  else { await session[action](); }
  const outcome = await awaitTurnEnd(session, prompt.seq);
  expect(outcome.kind).toBe(action === "failure" ? "failed" : "aborted");
  expect(run.streamDrained).toBe(true);
  const compactions = session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind.startsWith("compaction_")) : []);
  expect(compactions).toEqual([{ kind: "compaction_started" }]);
  await session.dispose();
});
