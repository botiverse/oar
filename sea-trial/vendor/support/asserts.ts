import assert from "node:assert/strict";
import type { ContextUsage, Session, Turn } from "../../../packages/oar/src/contracts/session.js";

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

/** Insist a probe reported available — assertion-style. */
export function expectAvailable<T extends { kind: string }>(installation: T, what: string): asserts installation is T & { kind: "available" } {
  assert.ok(installation.kind === "available", `${what} unavailable`);
}

/** Prompt and insist on a turn — assertion-style, per repo test convention. */
export function promptTurn(session: Session, input: string): Turn {
  const result = session.prompt(input);
  assert.ok(result.kind === "turn", `expected a turn for ${JSON.stringify(input)}, got busy`);
  return result.turn;
}

/** A well-formed context-usage snapshot (exact numbers vary by model/version). */
export function assertContextUsage(usage: ContextUsage | null | undefined): void {
  assert.ok(usage !== null && usage !== undefined, "contextUsage() returned nothing");
  assert.ok(usage.tokens === null || (typeof usage.tokens === "number" && usage.tokens >= 0), "tokens must be a non-negative number or null");
  assert.ok(usage.contextWindow === null || typeof usage.contextWindow === "number", "contextWindow must be a number or null");
  assert.ok(usage.percent === null || (typeof usage.percent === "number" && usage.percent >= 0), "percent must be a non-negative number or null");
}
