import { mkdir, writeFile } from "node:fs/promises";
import type { RawEvent } from "../../packages/oar/src/index.js";
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { dshEnabled, eventsOf, say, untilEvent, withDshFixture } from "./support/dsh-fixture.js";

// oxlint-disable-next-line eslint/max-lines-per-function -- One durable goal across a native restart and a refused mutation.
test.skipIf(!dshEnabled)("DSH goals retain paused state, reject token budgets without mutation, and clear natively", async () => {
  await withDshFixture(() => say("native continuation"), async ({ open }) => {
    const session = await open({ goals: true });
    assert.ok(session.goal !== undefined);
    expect(await session.goal.read()).toMatchObject({ kind: "accepted" });
    expect(eventsOf(session.records()).findLast((event) => event.kind === "goal_changed")).toEqual({ kind: "goal_changed", goal: null });
    expect(await session.goal.set({ objective: "Persist this goal", status: "paused" })).toMatchObject({ kind: "accepted" });
    const before = session.records().filter((record) => record.kind === "frame").length;
    expect(await session.goal.set({ objective: "Must not apply", tokenBudget: 12 })).toMatchObject({ kind: "rejected", code: "unsupported", reason: "DSH budgets count rounds, not tokens" });
    expect(session.records().filter((record) => record.kind === "frame")).toHaveLength(before);
    const snapshots = eventsOf(session.records()).filter((event) => event.kind === "goal_changed");
    expect(snapshots.at(-1)).toMatchObject({ goal: { objective: "Persist this goal", status: "paused" } });
    expect(snapshots.every((event) => event.goal === null || event.goal.tokenBudget === undefined)).toBe(true);
    await session.dispose();
    const resumed = await open({ resume: session.id, goals: true });
    assert.ok(resumed.goal !== undefined);
    expect(await resumed.goal.read()).toMatchObject({ kind: "accepted" });
    expect(eventsOf(resumed.records()).findLast((event) => event.kind === "goal_changed")).toMatchObject({ goal: { objective: "Persist this goal", status: "paused" } });
    expect(await resumed.goal.clear()).toMatchObject({ kind: "accepted" });
    expect(eventsOf(resumed.records()).findLast((event) => event.kind === "goal_changed")).toEqual({ kind: "goal_changed", goal: null });
    expect(await resumed.goal.clear()).toMatchObject({ kind: "accepted" });
    await resumed.dispose();
    const omitted = await open({ resume: session.id });
    expect(omitted.goal).toBeUndefined();
  });
}, 60_000);

test.skipIf(!dshEnabled)("DSH host pause cancels the native running goal turn", async () => {
  await withDshFixture(() => ({ kind: "hold", text: "working" }), async ({ open, provider }) => {
    const session = await open({ goals: true });
    assert.ok(session.goal !== undefined);
    expect(await session.goal.set({ objective: "Continue natively", status: "active" })).toMatchObject({ kind: "accepted" });
    await provider.held();
    expect(await session.goal.set({ objective: "Continue natively", status: "paused" })).toMatchObject({ kind: "accepted" });
    await untilEvent(session, (event) => event.kind === "turn_ended");
    expect(eventsOf(session.records()).findLast((event) => event.kind === "turn_ended")).toMatchObject({ kind: "turn_ended", outcome: { kind: "aborted" } });
    expect(eventsOf(session.records()).findLast((event) => event.kind === "goal_changed")).toMatchObject({ goal: { status: "paused" } });
    expect(provider.requests).toHaveLength(1);
    await saveGoalTrace("pause", session.records());
  });
}, 30_000);

test.skipIf(!dshEnabled)("DSH clear leaves an already running native goal turn alone", async () => {
  await withDshFixture(() => ({ kind: "hold", text: "working" }), async ({ open, provider }) => {
    const session = await open({ goals: true });
    assert.ok(session.goal !== undefined);
    expect(await session.goal.set({ objective: "Continue natively", status: "active" })).toMatchObject({ kind: "accepted" });
    await provider.held();
    expect(await session.goal.clear()).toMatchObject({ kind: "accepted" });
    expect(eventsOf(session.records()).some((event) => event.kind === "turn_ended")).toBe(false);
    provider.release();
    await untilEvent(session, (event) => event.kind === "turn_ended");
    expect(eventsOf(session.records()).findLast((event) => event.kind === "turn_ended")).toMatchObject({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect(provider.requests).toHaveLength(1);
    await saveGoalTrace("clear", session.records());
  });
}, 30_000);

async function saveGoalTrace(name: string, records: readonly RawEvent[]): Promise<void> {
  await mkdir("oar-trial-run", { recursive: true });
  await writeFile(`oar-trial-run/dsh-goal-${name}.json`, JSON.stringify(records, null, 2));
}
