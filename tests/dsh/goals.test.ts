import type { DshControl } from "../../packages/oar/src/runtimes/dsh/control.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { expect, test, vi } from "vitest";
import { dshGoal, dshGoalControl, dshGoalEvents } from "../../packages/oar/src/runtimes/dsh/goal.js";
import { foldDsh, initialDshProjection } from "../../packages/oar/src/runtimes/dsh/projection.js";

test("DSH goal snapshots preserve native phases and convert time units without inventing token counters", () => {
  expect(dshGoal({ objective: "work", phase: "blocked", maxGoalRounds: 256, roundsStarted: 3, createdAt: 12_340, updatedAt: 56_780 })).toMatchInlineSnapshot(`
    {
      "createdAt": 12.34,
      "objective": "work",
      "status": "blocked",
      "updatedAt": 56.78,
    }
  `);
  expect(dshGoal({ objective: "work", phase: "future-native-phase" })).toMatchInlineSnapshot(`
    {
      "objective": "work",
      "status": "future-native-phase",
    }
  `);
  expect(dshGoal({ objective: "malformed" })).toBeUndefined();
  expect(dshGoal(null)).toBeNull();
});

test("DSH durable changes and reads stay at their native stream position without changing turn state", () => {
  const initial = initialDshProjection("root");
  const active = foldDsh(initial, { type: "native", channel: "session/event", sessionId: "root", event: { type: "turn/start", data: {} } });
  const native = { type: "goal/change", data: { version: 1, operation: "pause", goal: { objective: "work", phase: "paused", maxGoalRounds: 256 }, createdAt: 1000, updatedAt: 2000 } };
  const change = foldDsh(active.state, { type: "native", channel: "session/event", sessionId: "root", event: native });
  expect(change.frame.body.native).toBe(native);
  expect(change.state.sessions.root?.turnOpen).toBe(true);
  expect(change.frame.body.events).toMatchInlineSnapshot(`
    [
      {
        "goal": {
          "createdAt": 1,
          "objective": "work",
          "status": "paused",
          "updatedAt": 2,
        },
        "kind": "goal_changed",
      },
    ]
  `);
  const childRead = foldDsh(change.state, { type: "native", channel: "goal/read", sessionId: "child", goal: null });
  expect(childRead.frame.sessionId).toBe("child");
  expect(childRead.frame.body.events).toEqual([{ kind: "goal_changed", goal: null }]);
});

test("DSH unknown goal versions and malformed clear notifications remain raw", () => {
  expect(dshGoalEvents({ version: 2, operation: "clear", cleared: { id: "future" } })).toEqual([]);
  expect(dshGoalEvents({ version: 1, operation: "clear" })).toEqual([]);
});

test("DSH null is an observed absence for read, but cannot confirm setting a goal", async () => {
  const kernel = createSessionKernel("root");
  const request = vi.fn<DshControl["request"]>().mockResolvedValue({ goal: null });
  const control = { ready: Promise.resolve({ protocol: 1, services: {} }), request };
  const goal = dshGoalControl(kernel, control, "root", () => ({ kind: "rejected", code: "error", reason: "unexpected" }));
  expect(await goal.read()).toMatchObject({ response: { body: { kind: "accepted" } } });
  expect(await goal.set({ objective: "work" })).toMatchObject({ response: { body: { kind: "rejected", code: "runtime_refused" } } });
  expect(kernel.records().filter((record) => record.kind === "frame")).toHaveLength(0);
});
