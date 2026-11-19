import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DshControl } from "../../packages/oar/src/runtimes/dsh/control.js";
import { dshRuntime } from "../../packages/oar/src/index.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { expect, test, vi } from "vitest";
import { dshGoal, dshGoalControl, dshGoalEvents } from "../../packages/oar/src/runtimes/dsh/goal.js";
import { foldDsh, initialDshProjection } from "../../packages/oar/src/runtimes/dsh/projection.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

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

// oxlint-disable-next-line eslint/max-statements -- Spawned bridge fixture verifies a failed create/edit refuses without invoking undefined status mutations while preserving observed native state.
test("DSH bridge goal.set refuses when create/edit returns undefined without calling status mutations and records observed native state", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-dsh-goal-refusal-"));
  try {
    const script = path.join(dir, "fake-dsh-goal.mjs");
    const callsFile = path.join(dir, "status-calls.json");
    writeFileSync(script, `
      import { readFileSync, writeFileSync } from "node:fs";
      if (process.argv.includes("--version")) { process.stdout.write("0.2.1-rc.5\\n"); process.exit(0); }
      const patch = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--patch") + 1], "utf8"));
      const bridgeRow = patch[1].insert.find(r => r.id === "oar-dsh-bridge");
      const bridge = await import(bridgeRow.name);
      const listeners = new Map();
      const on = (ch, fn) => { listeners.set(ch, [...(listeners.get(ch) ?? []), fn]); return () => {}; };
      const statusCalls = [];
      let storedGoal = undefined;
      const goals = {
        get: () => storedGoal,
        create: (_a, { objective }) => { storedGoal = objective === "broken" ? undefined : { id: "g1", objective, phase: "active" }; return storedGoal; },
        edit: (_a, _c, { objective }) => { if (objective !== "broken") { storedGoal = { id: "g1", objective, phase: "active" }; return storedGoal; } storedGoal = undefined; return undefined; },
        pause: (_a, current) => { statusCalls.push(["pause", current ?? null]); },
        resume: (_a, current) => { statusCalls.push(["resume", current ?? null]); },
        complete: (_a, current) => { statusCalls.push(["complete", current ?? null]); },
        clear: () => { storedGoal = undefined; },
      };
      const services = {
        goals,
        agents: { create: async ({ sessionId, setup }) => { const session = { id: sessionId, header: { id: sessionId, cwd: process.cwd() } }; const agent = { session, status: "idle", inbox: { nextTurn: [], nextStep: [] }, followup() {}, cancel() {} }; await setup?.({}, agent); return { agent, dispose: async () => {} }; } },
        sessionPersistence: { flush: async () => {} },
        llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), resolveCallConfig: async r => r },
        agentDefaultModel: { currentSelection: () => ({ provider: "local", model: "m" }) },
      };
      bridge.apply({ get: n => n === "loader" ? { await: async () => {} } : services[n], on, effect: () => {} }, bridgeRow.config ?? {});
      process.stdin.on("end", () => { writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(statusCalls)); process.exit(0); });
    `);
    const command = fakeAgentBinary(dir, [script]);
    const session = await dshRuntime.session({ kind: "available", via: "executable", command, version: "0.2.1-rc.5" }, { cwd: dir, goals: true });
    try {
      const accepted = await session.goal?.set({ objective: "keep-me" });
      expect(accepted?.kind).toBe("accepted");
      expect(await session.goal?.set({ objective: "broken", status: "paused" })).toMatchObject({ kind: "rejected", code: "runtime_refused" });
      const goalEvents = session.records().flatMap(record => record.kind === "frame" ? record.body.events.filter(event => event.kind === "goal_changed") : []);
      expect(goalEvents).toEqual([
        { kind: "goal_changed", goal: { objective: "keep-me", status: "active" } },
        { kind: "goal_changed", goal: null },
      ]);
    } finally { await session.dispose(); }
    expect(JSON.parse(readFileSync(callsFile, "utf8"))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
