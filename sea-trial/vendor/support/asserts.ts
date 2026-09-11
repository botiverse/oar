import assert from "node:assert/strict";
import type { ContextUsage, ControlResult, Session, TurnOutcome } from "../../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../../packages/oar/src/observe/turns.js";

/** Run a body with process.env overlaid (readers read process.env, not SessionOptions.env), restoring the previous values afterwards. */
export async function withProcessEnv(
  overlay: Readonly<Record<string, string>>,
  body: () => Promise<void>,
): Promise<void> {
  const previous = new Map(Object.keys(overlay).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overlay);
  try {
    await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Insist a probe reported available, assertion-style. */
export function expectAvailable<T extends { kind: string }>(installation: T, what: string): asserts installation is T & { kind: "available" } {
  assert.ok(installation.kind === "available", `${what} unavailable`);
}

/** Prompt and insist the runtime accepted it, assertion-style, per repo test convention. */
export async function promptTurn(session: Session, input: string): Promise<ControlResult> {
  const result = await session.prompt(input);
  assert.ok(
    result.response.body.kind === "accepted",
    `expected an accepted prompt for ${JSON.stringify(input)}, got ${JSON.stringify(result.response.body)}`,
  );
  return result;
}

/** Prompt, insist it was accepted, and wait for the runtime's own turn end. */
export async function runTurn(session: Session, input: string): Promise<TurnOutcome> {
  const result = await promptTurn(session, input);
  return awaitTurnEnd(session, result.request.seq);
}

/** A well-formed context-usage snapshot (exact numbers vary by model/version). */
export function assertContextUsage(usage: ContextUsage | null | undefined): void {
  assert.ok(usage !== null && usage !== undefined, "contextUsage() returned nothing");
  assert.ok(usage.tokens === null || (typeof usage.tokens === "number" && usage.tokens >= 0), "tokens must be a non-negative number or null");
  assert.ok(usage.contextWindow === null || typeof usage.contextWindow === "number", "contextWindow must be a number or null");
  assert.ok(usage.percent === null || (typeof usage.percent === "number" && usage.percent >= 0), "percent must be a non-negative number or null");
}
