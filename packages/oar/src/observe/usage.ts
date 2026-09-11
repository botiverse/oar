import type {
  ContextUsage,
  SessionRecord,
  SessionUsage,
  TokenTotals,
} from "../contracts/session.js";

/**
 * Query = projection over the stream. Model, token usage and context
 * fullness are folds over seq-carrying records — never a second source of
 * truth held beside the stream — so every answer can be aligned with the
 * record that produced it and reproduced from a replay.
 */

function pathKey(agentPath: readonly string[]): string {
  return JSON.stringify(agentPath);
}

/** The latest model the runtime reported for the root agent; null before any. */
export function modelOf(records: readonly SessionRecord[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.kind === "event" && record.agentPath.length === 0) {
      const view = record.body.views.findLast((candidate) => candidate.kind === "model");
      if (view?.kind === "model") {
        return view.model;
      }
    }
  }
  return null;
}

/** The latest context fullness the runtime reported for the root agent; null before any. */
export function contextUsageOf(records: readonly SessionRecord[]): ContextUsage | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.kind === "event" && record.agentPath.length === 0) {
      const view = record.body.views.findLast((candidate) => candidate.kind === "usage" && candidate.usage.context !== undefined);
      if (view?.kind === "usage" && view.usage.context !== undefined) {
        return view.usage.context;
      }
    }
  }
  return null;
}

/**
 * Session total plus a per-agent breakdown. Each agent's totals are the
 * LATEST cumulative figure its records reported (adapters resolve their
 * runtime's accounting into cumulative-per-agent before the record is
 * stamped), so the breakdown is deduplicated by construction and sums to the
 * total.
 */
export function usageOf(records: readonly SessionRecord[]): SessionUsage {
  const latest = new Map<string, { readonly agentPath: readonly string[]; readonly tokens: TokenTotals }>();
  for (const record of records) {
    if (record.kind !== "event") {
      continue;
    }
    for (const view of record.body.views) {
      if (view.kind === "usage" && view.usage.tokens !== undefined) {
        latest.set(pathKey(record.agentPath), { agentPath: record.agentPath, tokens: view.usage.tokens });
      }
    }
  }
  const byAgent = [...latest.values()];
  const total = byAgent.reduce<TokenTotals>(
    (sum, entry) => ({ input: sum.input + entry.tokens.input, output: sum.output + entry.tokens.output }),
    { input: 0, output: 0 },
  );
  const onlyRoot = byAgent.length <= 1 && byAgent.every((entry) => entry.agentPath.length === 0);
  return onlyRoot ? { total } : { total, byAgent };
}
