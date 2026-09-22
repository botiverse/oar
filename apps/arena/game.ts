/**
 * Arena rules: a deterministic referee. Both fighters pick a move in secret
 * each round; the one who answered faster resolves first. Nothing here knows
 * about agents: a fighter is whatever hands the referee a move.
 */

export type Side = "left" | "right";

export const MOVES = ["patch", "refactor", "rm_rf", "sandbox", "compact", "think", "inject"] as const;
export type Move = (typeof MOVES)[number];
/** What a fighter ends up doing when it answers nothing legal (bad JSON, unknown move, not enough tokens, timeout, or it was injected). */
export type Action = Move | "hallucinate";

// Healing costs what a refactor costs and restores less than one deals: a fighter that only heals loses.
const HEAL = 18;

export const RULES = {
  maxHp: 100,
  startTokens: 2,
  maxTokens: 6,
  maxRounds: 20,
  hallucinationDamage: 5,
  rmRfRecoil: 10,
  sandboxBlock: 0.7,
  /** A sandbox raised two rounds running is already half torn down. */
  staleSandboxBlock: 0.3,
} as const;

export const MOVE_INFO: Readonly<Record<Move, { readonly cost: number; readonly summary: string }>> = {
  patch: { cost: 0, summary: "12 damage." },
  refactor: { cost: 2, summary: "26 damage." },
  rm_rf: { cost: 4, summary: `45 damage. Against a sandbox it deals 0 and you take ${String(RULES.rmRfRecoil)} recoil (permission denied).` },
  sandbox: { cost: 0, summary: `Block ${String(RULES.sandboxBlock * 100)}% of incoming damage this round and every inject. Only ${String(RULES.staleSandboxBlock * 100)}% if you also used it last round.` },
  compact: { cost: 2, summary: `Heal ${String(HEAL)} HP.` },
  think: { cost: 0, summary: "Gain 2 extra tokens." },
  inject: { cost: 3, summary: "Prompt injection: 8 damage and the opponent's NEXT move is replaced by a hallucination. Fully blocked by sandbox." },
};

const DAMAGE: Readonly<Partial<Record<Move, number>>> = { patch: 12, refactor: 26, rm_rf: 45, inject: 8 };
const THINK_GAIN = 2;

export interface FighterState {
  readonly hp: number;
  readonly tokens: number;
  /** The next move is forfeit: the opponent landed an inject. */
  readonly injected: boolean;
  readonly lastAction: Action | null;
}

export interface MatchState {
  /** Rounds already resolved. */
  readonly round: number;
  readonly left: FighterState;
  readonly right: FighterState;
}

export interface Choice {
  /** Null when the fighter produced no legal move. */
  readonly move: Move | null;
  /** How long the fighter took to answer; the faster one resolves first. */
  readonly ms: number;
}

export interface Step {
  readonly side: Side;
  readonly action: Action;
  /** Why the chosen move did not happen, when it did not. */
  readonly fizzle?: "invalid" | "no_tokens" | "injected" | "knocked_out";
  /** Damage the opponent took. */
  readonly damage: number;
  /** Damage the acting fighter took from its own action. */
  readonly selfDamage: number;
  readonly heal: number;
  readonly blocked: boolean;
  readonly injects: boolean;
}

export type Verdict =
  | { readonly kind: "ongoing" }
  | { readonly kind: "won"; readonly winner: Side; readonly by: "ko" | "decision" }
  | { readonly kind: "draw" };

export function initialMatch(): MatchState {
  const fresh: FighterState = { hp: RULES.maxHp, tokens: RULES.startTokens, injected: false, lastAction: null };
  return { round: 0, left: fresh, right: fresh };
}

export function other(side: Side): Side {
  return side === "left" ? "right" : "left";
}

export function parseMove(value: unknown): Move | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replaceAll(/[\s-]+/gu, "_");
  return MOVES.find((move) => move === normalized) ?? null;
}

function settle(fighter: FighterState, choice: Choice): { readonly action: Action; readonly fizzle?: Step["fizzle"] } {
  if (fighter.injected) {
    return { action: "hallucinate", fizzle: "injected" };
  }
  if (choice.move === null) {
    return { action: "hallucinate", fizzle: "invalid" };
  }
  if (MOVE_INFO[choice.move].cost > fighter.tokens) {
    return { action: "hallucinate", fizzle: "no_tokens" };
  }
  return { action: choice.move };
}

function blockOf(fighter: FighterState, action: Action): number {
  if (action !== "sandbox") {
    return 0;
  }
  return fighter.lastAction === "sandbox" ? RULES.staleSandboxBlock : RULES.sandboxBlock;
}

/** Resolve one round. Pure: same state and choices, same result. */
export function resolveRound(state: MatchState, choices: Readonly<Record<Side, Choice>>): { readonly state: MatchState; readonly steps: readonly Step[] } {
  const settled = { left: settle(state.left, choices.left), right: settle(state.right, choices.right) };
  const block = { left: blockOf(state.left, settled.left.action), right: blockOf(state.right, settled.right.action) };
  const hp = { left: state.left.hp, right: state.right.hp };
  const tokens = { left: state.left.tokens, right: state.right.tokens };
  const injectedNext = { left: false, right: false };
  // Ties go left: there is no fair coin in a pure function, and a millisecond tie between two model calls does not happen.
  const first: Side = choices.right.ms < choices.left.ms ? "right" : "left";
  const steps: Step[] = [];

  for (const side of [first, other(first)]) {
    const foe = other(side);
    const { action, fizzle } = settled[side];
    if (hp[side] <= 0) {
      steps.push({ side, action, fizzle: "knocked_out", damage: 0, selfDamage: 0, heal: 0, blocked: false, injects: false });
      continue;
    }
    let damage = 0;
    let selfDamage = 0;
    let heal = 0;
    let blocked = false;
    let injects = false;
    if (action === "hallucinate") {
      selfDamage = RULES.hallucinationDamage;
    } else {
      tokens[side] -= MOVE_INFO[action].cost;
      const base = DAMAGE[action] ?? 0;
      blocked = base > 0 && block[foe] > 0;
      if (action === "rm_rf" && blocked) {
        selfDamage = RULES.rmRfRecoil;
      } else {
        damage = Math.round(base * (1 - block[foe]));
      }
      if (action === "inject" && !blocked) {
        injects = true;
        injectedNext[foe] = true;
      }
      if (action === "compact") {
        heal = Math.min(HEAL, RULES.maxHp - hp[side]);
      }
      if (action === "think") {
        tokens[side] += THINK_GAIN;
      }
    }
    hp[foe] = Math.max(0, hp[foe] - damage);
    hp[side] = Math.max(0, hp[side] - selfDamage) + heal;
    steps.push({ side, action, ...(fizzle === undefined ? {} : { fizzle }), damage, selfDamage, heal, blocked, injects });
  }

  const next = (side: Side): FighterState => ({
    hp: hp[side],
    tokens: Math.min(RULES.maxTokens, tokens[side] + 1),
    injected: injectedNext[side],
    lastAction: settled[side].action,
  });
  return { state: { round: state.round + 1, left: next("left"), right: next("right") }, steps };
}

export function verdictOf(state: MatchState): Verdict {
  const leftDown = state.left.hp <= 0;
  const rightDown = state.right.hp <= 0;
  if (leftDown && rightDown) {
    return { kind: "draw" };
  }
  if (leftDown || rightDown) {
    return { kind: "won", winner: leftDown ? "right" : "left", by: "ko" };
  }
  if (state.round < RULES.maxRounds) {
    return { kind: "ongoing" };
  }
  if (state.left.hp === state.right.hp) {
    return { kind: "draw" };
  }
  return { kind: "won", winner: state.left.hp > state.right.hp ? "left" : "right", by: "decision" };
}
