import type {
  ContextUsage,
  QueryResult,
  RawEvent,
  SessionUsage,
  TokenTotals,
} from "../contracts/session.js";

/**
 * Query = projection over the stream. Model, token usage and context
 * fullness are folds over seq-carrying records, never a second source of
 * truth held beside the stream, so every answer can be aligned with the
 * record that produced it and reproduced from a replay.
 *
 * Scope: one session. A derived child session (codex child thread, grok child
 * session) carries its own `sessionId` and `agentPath []` on its records; it
 * is a separate session, not a sub-agent of this one, so its figures are NOT
 * folded into this session's answers. When `sessionId` is given, records of
 * other sessions are skipped; the session graph says where the child came
 * from and the child's own records hold its usage. Observed live on codex
 * 0.149.0: both threads report `thread/tokenUsage/updated` with cumulative
 * totals on the parent's connection, and without this scope the child's
 * figure overwrote the root's under the same `agentPath []` key.
 */

function pathKey(agentPath: readonly string[]): string {
  return JSON.stringify(agentPath);
}

function inSession(record: RawEvent, sessionId: string | undefined): boolean {
  return sessionId === undefined || record.sessionId === sessionId;
}

/** The latest model the runtime reported for the root agent; null before any. */
export function modelOf(records: readonly RawEvent[], sessionId?: string): QueryResult<string | null> {
  let value: string | null = null;
  let seq = -1;
  for (const record of records) {
    if (!inSession(record, sessionId)) { continue; }
    seq = record.seq;
    if (record.kind === "frame" && record.agentPath.length === 0) {
      const event = record.body.events.findLast((candidate) => candidate.kind === "model");
      if (event?.kind === "model") { value = event.model; }
    }
  }
  return { value, seq };
}

/** The latest context fullness the runtime reported for the root agent; null before any. */
export function contextUsageOf(records: readonly RawEvent[], sessionId?: string): QueryResult<ContextUsage | null> {
  let value: ContextUsage | null = null;
  let seq = -1;
  for (const record of records) {
    if (!inSession(record, sessionId)) { continue; }
    seq = record.seq;
    if (record.kind === "frame" && record.agentPath.length === 0) {
      const event = record.body.events.findLast((candidate) => candidate.kind === "usage" && candidate.usage.context !== undefined);
      if (event?.kind === "usage" && event.usage.context !== undefined) { value = event.usage.context; }
    }
  }
  return { value, seq };
}

/**
 * Session total plus a per-agent breakdown. Each agent's totals are the
 * LATEST cumulative figure its records reported (adapters resolve their
 * runtime's accounting into cumulative-per-agent before the record is
 * stamped), so the breakdown is deduplicated by construction and sums to the
 * total. Agents are the `agentPath`s of THIS session; derived child sessions
 * are not agents of it.
 */
export function usageOf(records: readonly RawEvent[], sessionId?: string): QueryResult<SessionUsage> {
  const latest = new Map<string, { readonly agentPath: readonly string[]; readonly tokens: TokenTotals }>();
  let seq = -1;
  for (const record of records) {
    if (!inSession(record, sessionId)) { continue; }
    seq = record.seq;
    if (record.kind !== "frame") {
      continue;
    }
    for (const event of record.body.events) {
      if (event.kind === "usage" && event.usage.tokens !== undefined) {
        latest.set(pathKey(record.agentPath), { agentPath: record.agentPath, tokens: event.usage.tokens });
      }
    }
  }
  const byAgent = [...latest.values()];
  if (byAgent.length === 0) {
    // Nothing reported yet (or a runtime whose interface never carries token
    // totals): null, never a guessed zero.
    return { value: { total: null }, seq };
  }
  const total = byAgent.reduce<TokenTotals>(
    (sum, entry) => ({ input: sum.input + entry.tokens.input, output: sum.output + entry.tokens.output }),
    { input: 0, output: 0 },
  );
  const onlyRoot = byAgent.length <= 1 && byAgent.every((entry) => entry.agentPath.length === 0);
  return { value: onlyRoot ? { total } : { total, byAgent }, seq };
}
