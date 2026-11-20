import { afterEach, expect, test, vi } from "vitest";
import type { Session } from "../packages/oar/src/index.js";
import { addDayTokens, AgentBudget, dayExhausted, handoff, limitValue, msUntilNextDay, openedState, recyclePolicy, sessionTokens, shouldRecycle, utcDay } from "../apps/harbor/budget.js";
import type { AgentState, Message, Store } from "../apps/harbor/store.js";

const policy = { idleMs: 3_600_000, contextTokens: 128_000 };

test("recycles only an idle session past both thresholds", () => {
  expect(shouldRecycle(policy, 3_600_001, 128_001)).toBe(true);
  expect(shouldRecycle(policy, 3_600_000, 500_000)).toBe(false);
  expect(shouldRecycle(policy, 7_200_000, 128_000)).toBe(false);
  expect(shouldRecycle(policy, 7_200_000, null)).toBe(false);
  expect(shouldRecycle(null, 7_200_000, 500_000)).toBe(false);
});

function message(seq: number, from: string, to: readonly string[]): Message {
  return { seq, at: seq * 1000, from, text: `m${String(seq)}`, to };
}

const messages = [message(1, "qa", ["a"]), message(2, "qa", ["b"]), message(3, "a", []), message(4, "qa", ["a"]), message(5, "qa", ["a"])];

test("the handoff keeps this agent's messages before the trigger, oldest first", () => {
  const text = handoff(messages, "a", 5) ?? "";
  expect(text).toContain("msg=1 ");
  expect(text).toContain("msg=3 ");
  expect(text.indexOf("msg=1 ")).toBeLessThan(text.indexOf("msg=4 "));
  expect(text).not.toContain("msg=2 ");
  expect(text).not.toContain("msg=5 ");
  expect(handoff(messages, "c", 5)).toBeNull();
});

test("a small handoff budget keeps the newest messages", () => {
  const small = handoff(messages, "a", 5, 120) ?? "";
  expect(small).toContain("msg=4 ");
  expect(small).not.toContain("msg=1 ");
});

test("session tokens count children and cached input", () => {
  expect(sessionTokens({ total: { input: 100, output: 10 } })).toBe(110);
  expect(sessionTokens({ total: { input: 100, output: 10 }, withChildren: { input: 300, output: 30 } })).toBe(330);
  expect(sessionTokens({ total: null })).toBe(0);
});

test("the day count starts over at UTC midnight", () => {
  const evening = Date.parse("2026-11-20T23:00:00Z");
  const day = addDayTokens(addDayTokens(undefined, 600, evening), 500, evening);
  expect(day).toEqual({ day: "2026-11-20", tokens: 1100 });
  expect(dayExhausted(day, 1000, evening)).toBe(true);
  expect(dayExhausted(day, null, evening)).toBe(false);
  const next = evening + msUntilNextDay(evening);
  expect(new Date(next).toISOString()).toBe("2026-11-21T00:00:00.000Z");
  expect(dayExhausted(day, 1000, next)).toBe(false);
  expect(addDayTokens(day, 5, next)).toEqual({ day: "2026-11-21", tokens: 5 });
});

test("a resumed session keeps the last context size; a fresh one drops it", () => {
  const state = { name: "a", runtime: "claude", opens: 3, sessionId: "old", contextTokens: 400_000 };
  expect(openedState(state, "old", 4, true)).toMatchObject({ sessionId: "old", opens: 4, contextTokens: 400_000 });
  expect(openedState(state, "new", 4, false)).not.toHaveProperty("contextTokens");
});

test("malformed limits stop up instead of turning a control off", () => {
  expect(() => limitValue("day-tokens", "100k", 0, 1)).toThrow(/--day-tokens/u);
  expect(() => limitValue("day-tokens", "0", 0, 1)).toThrow(/at least 1/u);
  expect(() => recyclePolicy("typo", undefined)).toThrow(/--recycle-idle-min/u);
  expect(recyclePolicy("0", undefined)).toBeNull();
  expect(recyclePolicy(undefined, undefined)).toEqual({ idleMs: 3_600_000, contextTokens: 128_000 });
});

test("an oversized newest message still leaves an excerpt", () => {
  const big = [message(1, "qa", ["a"]), { ...message(2, "qa", ["a"]), text: "x".repeat(500) }];
  const text = handoff(big, "a", 3, 200) ?? "";
  expect(text).toContain("[truncated; harbor read shows it whole]");
  expect(text).not.toContain("msg=1 ");
});

function host(state: AgentState): { budget: (cap: number) => AgentBudget; journal: Record<string, unknown>[]; resumed: number[] } {
  const journal: Record<string, unknown>[] = [];
  const resumed: number[] = [];
  let current = state;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- AgentBudget only journals.
  const store = { journal: (entry: Record<string, unknown>): void => { journal.push(entry); } } as unknown as Store;
  const budgetHost = { name: "a", store, state: (): AgentState => current, setState: (next: AgentState): void => { current = next; }, resume: (): void => { resumed.push(1); } };
  return { budget: (cap) => new AgentBudget(null, cap, budgetHost), journal, resumed };
}

function sessionWith(tokens: number): Session {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- AgentBudget reads usage, context and status only.
  return { usage: () => ({ value: { total: { input: tokens, output: 0 } } }), contextUsage: () => ({ value: null }), status: () => ({ value: { kind: "idle" } }) } as unknown as Session;
}

test("a cap reached before a restart holds from the start", () => {
  const { budget, journal } = host({ name: "a", runtime: "claude", opens: 1, dayTokens: { day: utcDay(Date.now()), tokens: 105 } });
  const held = budget(100);
  expect(held.holding).toBe(true);
  expect(held.ready(sessionWith(0), async () => undefined)).toBe(false);
  expect(journal.map((entry) => entry.limit)).toEqual(["day_tokens"]);
});

test("usage is counted when reported, once, from the open baseline", () => {
  const { budget } = host({ name: "a", runtime: "claude", opens: 1 });
  const counting = budget(1000);
  counting.opened(sessionWith(400));
  counting.count(sessionWith(450));
  counting.count(sessionWith(450));
  counting.turnEnded(sessionWith(520), Date.now());
  expect(counting.holding).toBe(false);
  counting.count(sessionWith(1500));
  expect(counting.holding).toBe(true);
});

afterEach(() => {
  vi.useRealTimers();
});

function heldAtCap(): { counting: AgentBudget; resumed: number[] } {
  const { budget, resumed } = host({ name: "a", runtime: "claude", opens: 1 });
  const counting = budget(100);
  counting.opened(sessionWith(0));
  counting.count(sessionWith(150));
  expect(counting.holding).toBe(true);
  return { counting, resumed };
}

test("the midnight wakeup holds again when the new day is already full", () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-20T23:59:00Z"));
  const { counting, resumed } = heldAtCap();
  vi.setSystemTime(Date.parse("2026-11-21T00:00:00Z"));
  counting.count(sessionWith(260));
  vi.advanceTimersByTime(60_000);
  expect(counting.holding).toBe(true);
  expect(resumed).toHaveLength(0);
});
