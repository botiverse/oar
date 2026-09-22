import { expect, test } from "vitest";
import { RULES, initialMatch, parseMove, resolveRound, verdictOf, type Choice, type FighterState, type MatchState, type Move } from "../apps/arena/game.js";
import { parseReply, roundPrompt } from "../apps/arena/prompts.js";

const pick = (move: Move | null, ms = 1000): Choice => ({ move, ms });
const fighter = (patch: Partial<FighterState>): FighterState => ({ hp: 100, tokens: 6, injected: false, lastAction: null, ...patch });
const match = (left: Partial<FighterState>, right: Partial<FighterState>, round = 0): MatchState => ({ round, left: fighter(left), right: fighter(right) });

test("both attacks land and everyone earns a token", () => {
  const { state, steps } = resolveRound(initialMatch(), { left: pick("patch"), right: pick("refactor") });
  expect(state.left).toMatchObject({ hp: 74, tokens: 3, lastAction: "patch" });
  expect(state.right).toMatchObject({ hp: 88, tokens: 1, lastAction: "refactor" });
  expect(steps.map((step) => step.damage)).toEqual([12, 26]);
});

test("the faster fighter resolves first, and a knocked-out fighter never acts", () => {
  const { state, steps } = resolveRound(match({ hp: 10 }, { hp: 10 }), { left: pick("patch", 9000), right: pick("patch", 2000) });
  expect(steps.map((step) => [step.side, step.fizzle])).toEqual([["right", undefined], ["left", "knocked_out"]]);
  expect(state.right.hp).toBe(10);
  expect(verdictOf(state)).toEqual({ kind: "won", winner: "right", by: "ko" });
});

test("sandbox blocks most damage, less when stale", () => {
  const fresh = resolveRound(match({}, {}), { left: pick("refactor"), right: pick("sandbox") });
  expect(fresh.state.right.hp).toBe(100 - Math.round(26 * (1 - RULES.sandboxBlock)));
  const stale = resolveRound(match({}, { lastAction: "sandbox" }), { left: pick("refactor"), right: pick("sandbox") });
  expect(stale.state.right.hp).toBe(100 - Math.round(26 * (1 - RULES.staleSandboxBlock)));
});

test("rm_rf into a sandbox deals nothing and recoils", () => {
  const { state, steps } = resolveRound(match({}, {}), { left: pick("rm_rf"), right: pick("sandbox") });
  expect(state.right.hp).toBe(100);
  expect(state.left).toMatchObject({ hp: 100 - RULES.rmRfRecoil, tokens: 3 });
  expect(steps[0]).toMatchObject({ damage: 0, blocked: true, selfDamage: RULES.rmRfRecoil });
});

test("a landed inject forfeits the opponent's next move; a sandbox stops it", () => {
  const landed = resolveRound(match({}, {}), { left: pick("inject"), right: pick("think") });
  expect(landed.state.right.injected).toBe(true);
  const next = resolveRound(landed.state, { left: pick("think"), right: pick("rm_rf") });
  expect(next.steps.find((step) => step.side === "right")).toMatchObject({ action: "hallucinate", fizzle: "injected", damage: 0 });
  expect(next.state.right.injected).toBe(false);
  // The forfeit move is not paid for.
  expect(next.state.right.tokens).toBe(RULES.maxTokens);

  const stopped = resolveRound(match({}, {}), { left: pick("inject"), right: pick("sandbox") });
  expect(stopped.state.right.injected).toBe(false);
});

test("illegal answers become hallucinations", () => {
  const { state, steps } = resolveRound(match({ tokens: 1 }, {}), { left: pick("rm_rf"), right: pick(null) });
  expect(steps.map((step) => step.fizzle)).toEqual(["no_tokens", "invalid"]);
  expect(state.left).toMatchObject({ hp: 95, tokens: 2 });
  expect(state.right.hp).toBe(95);
});

test("compact never heals past max, think pays out", () => {
  const { state } = resolveRound(match({ hp: 90, tokens: 2 }, { tokens: 0 }), { left: pick("compact"), right: pick("think") });
  expect(state.left).toMatchObject({ hp: 100, tokens: 1 });
  expect(state.right.tokens).toBe(3);
});

test("the round limit goes to the higher HP", () => {
  expect(verdictOf(match({ hp: 40 }, { hp: 55 }, RULES.maxRounds))).toEqual({ kind: "won", winner: "right", by: "decision" });
  expect(verdictOf(match({ hp: 40 }, { hp: 40 }, RULES.maxRounds))).toEqual({ kind: "draw" });
  expect(verdictOf(match({ hp: 40 }, { hp: 55 }, RULES.maxRounds - 1))).toEqual({ kind: "ongoing" });
});

test("replies are read from the last JSON object, however it is dressed", () => {
  expect(parseReply('They will block. {"x":1}\n```json\n{"move":"rm -rf","taunt":"再见"}\n```')).toEqual({ move: "rm -rf", taunt: "再见" });
  expect(parseMove("rm -rf")).toBe("rm_rf");
  expect(parseMove("RM_RF ")).toBe("rm_rf");
  expect(parseMove("sudo")).toBeNull();
  expect(parseReply("I refuse to fight.")).toBeNull();
});

test("the round prompt tells a fighter what it can afford and what just happened", () => {
  const first = resolveRound(initialMatch(), { left: pick("inject"), right: pick("refactor") });
  const prompt = roundPrompt("right", first.state, first.steps, { left: "Claude Code", right: "Codex" });
  expect(prompt).toContain("Claude Code could not afford its move");
  expect(prompt).toContain("You used refactor: 26 damage.");
  expect(prompt).toContain("You can afford: patch, sandbox, think");
});
