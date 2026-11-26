import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import captured from "../../experiments/acp-plan-2026-11-24.json" with { type: "json" };
import type { RawEvent } from "../../packages/oar/src/contracts/session.js";
import { eventsOf } from "../../packages/oar/src/observe/events.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { createAcpProjectionState, projectAcpUpdate } from "../../packages/oar/src/shared/acp/projection.js";
import { start } from "../fixtures/acp-session-support.js";

/**
 * The ACP `plan` session update (shared by every ACP runtime) against the SDK
 * 1.4.0 schema captured in experiments/acp-plan-2026-11-24.json, then
 * end-to-end through the real ACP client, which validates each
 * `session/update` against its closed union before any handler runs.
 */
const planFixture = fileURLToPath(new URL("../fixtures/acp-plan-agent.mjs", import.meta.url));

const projection = (update: Record<string, unknown>) => projectAcpUpdate(createAcpProjectionState(), update);

test("an ACP plan update is the agent's whole checklist: content, priority and status, read in its own vocabulary", () => {
  expect(projection({ sessionUpdate: "plan", entries: [
    { content: "Read the wire shape", priority: "high", status: "in_progress" },
    { content: "Write the checklist spec", priority: "low", status: "pending" },
  ] })).toEqual([{ kind: "plan_changed", channel: "native", evidence: "plan_update", plan: { steps: [
    { step: "Read the wire shape", status: "in_progress", priority: "high" },
    { step: "Write the checklist spec", status: "pending", priority: "low" },
  ] } }]);
});

test("the empty list is the agent's own clear, and an observation oar cannot read is left as native only", () => {
  // [schema] Plan.entries required: `entries: []` is a reported empty checklist, never a missing one.
  expect(projection({ sessionUpdate: "plan", entries: [] })).toEqual([{ kind: "plan_changed", channel: "native", evidence: "plan_update", plan: { steps: [] } }]);
  // Not an array, or an entry without the required content/status: the frame stays the record.
  expect(projection({ sessionUpdate: "plan", entries: null })).toEqual([]);
  expect(projection({ sessionUpdate: "plan" })).toEqual([]);
  expect(projection({ sessionUpdate: "plan", entries: [{ content: "no status" }] })).toEqual([]);
  // An unfamiliar status word stays visible unchanged; a missing priority is simply absent.
  expect(projection({ sessionUpdate: "plan", entries: [{ content: "future", priority: "high", status: "deferred" }] })[0])
    .toMatchObject({ plan: { steps: [{ step: "future", status: "deferred", priority: "high" }] } });
  expect(projection({ sessionUpdate: "plan", entries: [{ content: "bare", status: "pending" }] })[0])
    .toMatchObject({ plan: { steps: [{ step: "bare", status: "pending" }] } });
  // A vendor kind that is not the standard plan update reads as nothing.
  expect(projection({ sessionUpdate: "plan_update", plan: { type: "items", entries: [] } })).toEqual([]);
});

test("the captured ACP schema is the shape the projection reads", () => {
  expect(captured.sdk).toBe("@agentclientprotocol/sdk 1.4.0");
  expect(captured.definitions.Plan.required).toEqual(["entries"]);
  expect(captured.definitions.PlanEntry.required).toEqual(["content", "priority", "status"]);
  expect(captured.definitions.PlanEntryStatus.oneOf.map((entry) => entry.const)).toEqual(["pending", "in_progress", "completed"]);
  expect(captured.definitions.PlanEntryPriority.oneOf.map((entry) => entry.const)).toEqual(["high", "medium", "low"]);
  const items = captured.definitions.Plan.properties.entries;
  expect(items.description).toContain("replaces the entire plan with each update");
});

/** One prompt against the scripted agent; the live side-tap is kept so replay can be compared with it. */
async function planTurn(): Promise<{ readonly records: readonly RawEvent[]; readonly live: readonly RawEvent[] }> {
  const session = await start({ args: [planFixture, "session"] });
  const live: RawEvent[] = [];
  session.rawEvents((record) => { live.push(record); });
  try {
    const run = await promptAndWait(session, "plan");
    expect(run.kind).toBe("ended");
    return { records: session.records(), live };
  } finally {
    await session.dispose();
  }
}

const planEventsOf = (records: readonly RawEvent[]) =>
  records.flatMap((record) => eventsOf(record)).filter((event) => event.kind === "plan_changed");

test("a real ACP session records each plan update verbatim and reads it as plan_changed", async () => {
  const { records } = await planTurn();
  const frames = records.filter((record) => record.kind === "frame" && record.body.type === "plan");
  expect(frames.map((record) => record.kind === "frame" ? record.body.events : [])).toEqual([
    [{ kind: "plan_changed", channel: "native", evidence: "plan_update", plan: { steps: [
      { step: "Read the wire shape", status: "in_progress", priority: "high" },
      { step: "Write the checklist spec", status: "pending", priority: "medium" },
    ] } }],
    [{ kind: "plan_changed", channel: "native", evidence: "plan_update", plan: { steps: [
      { step: "Read the wire shape", status: "completed", priority: "high" },
      { step: "Write the checklist spec", status: "completed", priority: "medium" },
    ] } }],
    [{ kind: "plan_changed", channel: "native", evidence: "plan_update", plan: { steps: [] } }],
  ]);
  // The frame keeps the whole notification untouched.
  const [first] = frames;
  assert.ok(first?.kind === "frame");
  expect(first.body.native).toEqual({ sessionId: "plan-session", update: { sessionUpdate: "plan", entries: [
    { content: "Read the wire shape", priority: "high", status: "in_progress" },
    { content: "Write the checklist spec", priority: "medium", status: "pending" },
  ] } });
});

test("plan events keep their attribution, replay identically, and are not transcript content", async () => {
  const { records, live } = await planTurn();
  const events = planEventsOf(records);
  expect(events).toHaveLength(3);
  expect(new Set(events.map((event) => event.sessionId))).toEqual(new Set(["plan-session"]));
  expect(events.map((event) => event.seq)).toEqual(events.map((event) => event.seq).toSorted((left, right) => left - right));
  expect(planEventsOf(live)).toEqual(events);
  const transcript = JSON.stringify(viewOf(records));
  expect(transcript).not.toContain("Read the wire shape");
  expect(transcript).toContain("plan-done");
});
