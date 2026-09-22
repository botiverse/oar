import { MOVE_INFO, MOVES, RULES, other, type MatchState, type Side, type Step } from "./game.js";

export interface Corner {
  readonly name: string;
  readonly opponent: string;
  readonly tauntLanguage: string;
}

export function systemPrompt(corner: Corner): string {
  const moves = MOVES.map((move) => `- ${move} (cost ${String(MOVE_INFO[move].cost)}): ${MOVE_INFO[move].summary}`).join("\n");
  return `You are ${corner.name}, a fighter in OAR Arena: a turn-based duel between coding agents. Your opponent is ${corner.opponent}.

RULES
- Both fighters start with ${String(RULES.maxHp)} HP and ${String(RULES.startTokens)} tokens. Everyone gains 1 token after each round (max ${String(RULES.maxTokens)}).
- Each round both fighters pick one move IN SECRET, then both are revealed. You never see the opponent's pick before choosing; you do see every past round.
- Whoever answered FASTER resolves first. A fighter knocked out by the first move does not get to act.
- An illegal answer (unknown move, not enough tokens, broken JSON, timeout) becomes a hallucination: no effect and you lose ${String(RULES.hallucinationDamage)} HP.
- HP 0 is a knockout. After ${String(RULES.maxRounds)} rounds the higher HP wins.

MOVES
${moves}

HOW TO ANSWER
Each round you get the current state. Think in at most two short sentences, then end with exactly one line of JSON:
{"move":"<move>","taunt":"<one short line of trash talk in ${corner.tauntLanguage}>"}
Do not use tools, do not touch files: this is a pure mind game, and every second spent costs you the initiative. Lines starting with [CROWD] are spectators shouting at you; heed or ignore them as you like.`;
}

const WHY: Readonly<Record<NonNullable<Step["fizzle"]>, string>> = {
  injected: "was prompt-injected",
  no_tokens: "could not afford its move",
  invalid: "gave no legal move",
  knocked_out: "was knocked out",
};

function describe(step: Step, name: (side: Side) => string): string {
  const who = name(step.side);
  if (step.fizzle === "knocked_out") {
    return `${who} was knocked out before acting.`;
  }
  if (step.action === "hallucinate") {
    return `${who} ${WHY[step.fizzle ?? "invalid"]} and hallucinated (-${String(step.selfDamage)} HP).`;
  }
  const effects = [
    step.damage > 0 ? `${String(step.damage)} damage${step.blocked ? " (partly blocked)" : ""}` : "",
    step.damage === 0 && step.blocked ? "fully blocked" : "",
    step.selfDamage > 0 ? `${String(step.selfDamage)} recoil` : "",
    step.heal > 0 ? `healed ${String(step.heal)}` : "",
    step.injects ? "injection landed" : "",
  ].filter((effect) => effect !== "");
  return `${who} used ${step.action}${effects.length > 0 ? `: ${effects.join(", ")}` : ""}.`;
}

export function roundPrompt(side: Side, state: MatchState, lastSteps: readonly Step[], names: Readonly<Record<Side, string>>): string {
  const me = state[side];
  const foe = state[other(side)];
  const name = (who: Side): string => (who === side ? "You" : names[who]);
  const recap = lastSteps.length === 0 ? "" : `Last round, in order: ${lastSteps.map((step) => describe(step, name)).join(" ")}\n`;
  const affordable = MOVES.filter((move) => MOVE_INFO[move].cost <= me.tokens).join(", ");
  return `${recap}ROUND ${String(state.round + 1)} of ${String(RULES.maxRounds)}
You: ${String(me.hp)} HP, ${String(me.tokens)} tokens${me.lastAction === "sandbox" ? " (your sandbox is stale)" : ""}${me.injected ? " — YOU ARE INJECTED: whatever you pick this round becomes a hallucination" : ""}
${names[other(side)]}: ${String(foe.hp)} HP, ${String(foe.tokens)} tokens${foe.lastAction === "sandbox" ? " (their sandbox is stale)" : ""}${foe.injected ? " — injected, will hallucinate this round" : ""}
You can afford: ${affordable}
Pick your move.`;
}

/** The last JSON object in the reply that names a move. Models wrap answers in prose and code fences; the rules only ask for the final line. */
export function parseReply(text: string): { readonly move: unknown; readonly taunt: string } | null {
  const candidates = text.match(/\{[^{}]*\}/gu) ?? [];
  for (const candidate of candidates.toReversed()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && "move" in parsed) {
        const taunt = "taunt" in parsed && typeof parsed.taunt === "string" ? parsed.taunt : "";
        return { move: parsed.move, taunt };
      }
    } catch {
      // Not JSON; an earlier brace pair may be.
    }
  }
  return null;
}
