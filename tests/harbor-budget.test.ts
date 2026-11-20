import { expect, test } from "vitest";
import { addDayTokens, dayExhausted, handoff, msUntilNextDay, openedState, sessionTokens, shouldRecycle } from "../apps/harbor/budget.js";
import type { Message } from "../apps/harbor/store.js";

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
