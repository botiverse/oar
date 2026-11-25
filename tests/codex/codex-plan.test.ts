import assert from "node:assert/strict";
import { expect, test } from "vitest";
import captured from "../../experiments/codex-plan-2026-11-24.json" with { type: "json" };
import type { Frame } from "../../packages/oar/src/contracts/session.js";
import { eventsOf } from "../../packages/oar/src/observe/events.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

/**
 * Codex's real `turn/plan/updated` notifications, captured from codex-cli
 * 0.171.0's app-server against a scripted local provider
 * (experiments/codex-plan-2026-11-24.json), folded through the production
 * projection. The `update_plan` tool's own schema is captured beside them
 * because the model's words and the app-server's words differ.
 */
const CAPTURED_THREAD = "01a20cff-eca5-7a30-af84-ebbb6cf5bc55";

function planFrame(params: JsonRecord, rootThreadId = CAPTURED_THREAD): Frame {
  const { commands } = foldCodexNotification(initialCodexProjection(rootThreadId), "turn/plan/updated", params);
  const [command] = commands;
  assert.ok(command?.kind === "frame");
  return { kind: "frame", sessionId: command.sessionId ?? rootThreadId, agentPath: [], seq: 0, receivedAt: 0, ...(command.spanId === undefined ? {} : { spanId: command.spanId }), body: command.body };
}

test("every captured codex plan notification reads as one plan_changed event and keeps its native verbatim", () => {
  expect(captured.codex).toBe("codex-cli 0.171.0");
  expect(captured.frames.map((frame) => frame.events)).toEqual([
    [{ kind: "plan_changed", evidence: "plan_update", plan: { steps: [
      { step: "Collect the native facts", status: "in_progress" },
      { step: "Write the checklist spec", status: "pending" },
    ], explanation: "Two steps to prove the wire" } }],
    [{ kind: "plan_changed", evidence: "plan_update", plan: { steps: [
      { step: "Collect the native facts", status: "completed" },
      { step: "Write the checklist spec", status: "completed" },
    ] } }],
    // codex sends `plan: []` for its own clear: a reported empty checklist, not missing evidence.
    [{ kind: "plan_changed", evidence: "plan_update", plan: { steps: [] } }],
  ]);
  for (const frame of captured.frames) {
    const folded = planFrame(asRecord(frame.native) ?? {});
    expect(folded.body.native).toEqual(frame.native);
    expect(folded.body.events).toEqual(frame.events);
    // The notification's turnId is the record's span, so the observation attributes to its turn.
    expect(folded.spanId).toEqual(asRecord(frame.native)?.turnId);
  }
});

test("codex's model-facing status words and its app-server's differ by spelling, and both are read", () => {
  const status = asRecord(asRecord(asRecord(captured.tool)?.parameters)?.properties)?.plan;
  const items = asRecord(asRecord(status)?.items);
  expect(asRecord(items?.properties)?.status).toMatchObject({ enum: ["pending", "in_progress", "completed"] });
  // The tool call above sent `in_progress`; the app-server reported `inProgress` for the same step.
  const reportedPlan = asRecord(captured.frames[0]?.native)?.plan;
  expect(asRecord(Array.isArray(reportedPlan) ? reportedPlan[0] : undefined)?.status).toBe("inProgress");
  // An unfamiliar status word stays visible unchanged; an explanation is kept only when non-empty.
  const future = planFrame({ threadId: CAPTURED_THREAD, plan: [{ step: "future", status: "deferred" }], explanation: null });
  expect(future.body.events).toEqual([{ kind: "plan_changed", evidence: "plan_update", plan: { steps: [{ step: "future", status: "deferred" }] } }]);
});

test("an observation oar cannot read stays a frame with no event, and never becomes another kind", () => {
  // plan not an array, a member without step/status: native only.
  expect(planFrame({ threadId: CAPTURED_THREAD, plan: "Collect the facts" }).body.events).toEqual([]);
  expect(planFrame({ threadId: CAPTURED_THREAD, plan: [{ step: "no status" }] }).body.events).toEqual([]);
  // Nothing else produces a checklist: no turn end, task or message is read as one.
  const { commands } = foldCodexNotification(initialCodexProjection(CAPTURED_THREAD), "turn/completed", { threadId: CAPTURED_THREAD, turn: { id: "turn-1", status: "completed" } });
  expect(commands.flatMap((command) => command.kind === "frame" ? command.body.events : []).some((event) => event.kind === "plan_changed")).toBe(false);
});

test("replay reads the same plan facts from the recorded frame, with the same attribution", () => {
  const recorded = planFrame(asRecord(captured.frames[0]?.native) ?? {});
  const replayed = eventsOf(recorded);
  expect(replayed).toHaveLength(1);
  expect(replayed[0]).toMatchObject({ kind: "plan_changed", sessionId: CAPTURED_THREAD, agentPath: [], spanId: asRecord(captured.frames[0]?.native)?.turnId });
  // A checklist is state, not transcript: no text, user message or task event is read out of it.
  expect(replayed.map((event) => event.kind)).toEqual(["plan_changed"]);
});
