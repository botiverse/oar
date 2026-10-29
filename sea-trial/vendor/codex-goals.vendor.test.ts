import { describe, expect, test } from "vitest";
import type { Event, GoalSnapshot, Session } from "../../packages/oar/src/contracts/session.js";
import { codexInstallation, codexSession, promptAndWait } from "../../packages/oar/src/index.js";
import { startCodexAimock } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";

function latest(events: readonly Event[]): GoalSnapshot | null | undefined {
  const event = events.findLast((item) => item.kind === "goal_changed");
  return event?.kind === "goal_changed" ? event.goal : undefined;
}
function observe(session: Session): Event[] {
  const events: Event[] = [];
  session.events((event) => { events.push(event); }, { cursor: { sessionId: session.id, afterSeq: -1 } });
  return events;
}

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex native goal controls", () => {
  // oxlint-disable-next-line eslint/max-statements -- Keep the persistent-goal lifecycle and its readback together.
  test("read, set, rejected update, resume and clear reflect native state without inferring completion", async () => {
    const provider = await startCodexAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "ordinary completion" }); });
    const installation = await codexInstallation(); expectAvailable(installation, "codex");
    let session: Session | undefined = undefined;
    try {
      session = await codexSession(installation, { cwd: process.cwd(), env: { ...provider.env }, goals: true });
      let events = observe(session);
      expect(await session.goal?.read()).toMatchObject({ kind: "accepted" });
      expect(latest(events)).toBeNull();
      expect(await session.goal?.set({ objective: "Persist this objective", status: "paused", tokenBudget: 100_000 })).toMatchObject({ kind: "accepted" });
      expect(latest(events)).toMatchObject({ objective: "Persist this objective", status: "paused", tokenBudget: 100_000, tokensUsed: 0 });
      const saved = latest(events);
      expect(await session.goal?.set({ objective: "   ", status: "active" })).toMatchObject({ kind: "rejected", code: "runtime_refused" });
      expect(latest(events)).toEqual(saved);
      expect(await promptAndWait(session, "ordinary turn")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      expect(await session.goal?.read()).toMatchObject({ kind: "accepted" });
      expect(latest(events)?.status).toBe("paused");
      const resume = session.id; await session.dispose();
      session = await codexSession(installation, { cwd: process.cwd(), env: { ...provider.env }, goals: true, resume });
      events = observe(session);
      await expect.poll(() => latest(events), { timeout: 10_000 }).toMatchObject({ objective: "Persist this objective", status: "paused" });
      expect(await session.goal?.clear()).toMatchObject({ kind: "accepted" });
      expect(latest(events)).toBeNull();
      expect(await session.goal?.clear()).toMatchObject({ kind: "accepted" });
      expect(session.records().findLast((record) => record.kind === "frame" && record.body.type === "thread/goal/clear")).toMatchObject({ body: { native: { cleared: false } } });
      expect(await session.goal?.read()).toMatchObject({ kind: "accepted" });
      expect(latest(events)).toBeNull();
    } finally { await session?.dispose(); await provider.stop(); }
  }, 90_000);

  test("native continuation and completion need no OAR prompt loop", async () => {
    let active = false;
    const provider = await startCodexAimock((mock) => {
      mock.on({ predicate: (request) => request.messages.at(-1)?.tool_call_id === "goal-completed" }, { content: "GOAL_FINISHED" });
      mock.on({ predicate: (request) => active && request.messages.at(-1)?.tool_call_id !== "goal-completed" && JSON.stringify(request.messages).includes("WORK_ROUND_ONE") }, {
        toolCalls: [{ id: "goal-completed", name: "update_goal", arguments: '{"status":"complete"}' }],
      });
      mock.on({ predicate: (request) => active && !JSON.stringify(request.messages).includes("WORK_ROUND_ONE") }, { content: "WORK_ROUND_ONE" });
      mock.on({ predicate: () => !active }, { content: "SEEDED" });
    });
    const installation = await codexInstallation(); expectAvailable(installation, "codex");
    let session: Session | undefined = undefined;
    try {
      session = await codexSession(installation, { cwd: process.cwd(), env: { ...provider.env }, goals: true });
      const events = observe(session);
      await promptAndWait(session, "seed");
      active = true;
      expect(await session.goal?.set({ objective: "Finish the local test on the next automatic continuation", status: "active", tokenBudget: 100_000 })).toMatchObject({ kind: "accepted" });
      await expect.poll(() => latest(events)?.status, { timeout: 20_000 }).toBe("complete");
      await expect.poll(() => events.filter((event) => event.kind === "turn_ended").length, { timeout: 20_000 }).toBe(3);
      expect(session.records().filter((record) => record.kind === "request" && record.body.kind === "prompt")).toHaveLength(1);
      expect(session.status().value.kind).toBe("idle");
      expect(await session.goal?.read()).toMatchObject({ kind: "accepted" });
      expect(latest(events)?.status).toBe("complete");
    } finally { await session?.dispose(); await provider.stop(); }
  }, 90_000);

  test("native budget exhaustion reports its counters and stops continuation", async () => {
    let active = false;
    const provider = await startCodexAimock((mock) => {
      mock.on({ predicate: () => active }, { content: "BUDGET_WORK", usage: { input_tokens: 40, output_tokens: 20 } });
      mock.on({ predicate: () => !active }, { content: "SEEDED" });
    });
    const installation = await codexInstallation(); expectAvailable(installation, "codex");
    let session: Session | undefined = undefined;
    try {
      session = await codexSession(installation, { cwd: process.cwd(), env: { ...provider.env }, goals: true });
      await promptAndWait(session, "seed");
      const events = observe(session); active = true;
      expect(await session.goal?.set({ objective: "Spend a bounded native budget", status: "active", tokenBudget: 1 })).toMatchObject({ kind: "accepted" });
      await expect.poll(() => latest(events), { timeout: 20_000 }).toMatchObject({ status: "budgetLimited", tokenBudget: 1, tokensUsed: 60 });
      await expect.poll(() => session?.status().value.kind, { timeout: 10_000 }).toBe("idle");
      expect(session.records().filter((record) => record.kind === "request" && record.body.kind === "prompt")).toHaveLength(1);
      expect(await session.goal?.read()).toMatchObject({ kind: "accepted" });
      expect(latest(events)?.status).toBe("budgetLimited");
    } finally { await session?.dispose(); await provider.stop(); }
  }, 60_000);

  test("pause changes the goal while a slow native turn continues to its own end", async () => {
    let slow = false;
    const provider = await startCodexAimock((mock) => {
      mock.on({ predicate: () => slow }, { content: "SLOW_COMPLETE" }, { streamingProfile: { ttft: 1800, tps: 1000 } });
      mock.on({ predicate: () => !slow }, { content: "SEEDED" });
    }, { captureRaw: true });
    const installation = await codexInstallation(); expectAvailable(installation, "codex");
    let session: Session | undefined = undefined;
    try {
      session = await codexSession(installation, { cwd: process.cwd(), env: { ...provider.env }, goals: true });
      await promptAndWait(session, "seed");
      const events: Event[] = []; session.events((event) => { events.push(event); });
      const requests = provider.raw.length; slow = true;
      expect(await session.goal?.set({ objective: "Slow work", status: "active", tokenBudget: 100_000 })).toMatchObject({ kind: "accepted" });
      await expect.poll(() => provider.raw.length, { timeout: 10_000 }).toBeGreaterThan(requests);
      expect(await session.goal?.set({ objective: "Slow work", status: "paused" })).toMatchObject({ kind: "accepted" });
      expect(latest(events)?.status).toBe("paused");
      expect(events.some((event) => event.kind === "turn_ended")).toBe(false);
      expect(session.status().value.kind).toBe("running");
      await expect.poll(() => events.some((event) => event.kind === "turn_ended"), { timeout: 10_000 }).toBe(true);
      expect(events.findLast((event) => event.kind === "turn_ended")).toMatchObject({ outcome: { kind: "completed" } });
      expect(await session.goal?.read()).toMatchObject({ kind: "accepted" });
      expect(latest(events)?.status).toBe("paused");
    } finally { await session?.dispose(); await provider.stop(); }
  }, 60_000);
});
