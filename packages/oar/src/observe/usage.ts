import type {
  ContextUsage,
  QueryResult,
  RawEvent,
  SessionGraph,
  SessionUsage,
} from "../contracts/session.js";
import { graphOf } from "./graph.js";
import { derivedFrom, foldSessionTokens, usageFromSessions, type SessionTokens } from "./usage-totals.js";

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
 * from and the child's own records hold its usage, which only `usageOf`'s
 * `withChildren` adds, apart from the session's own figures. Observed live on codex
 * 0.149.0: both threads report `thread/tokenUsage/updated` with cumulative
 * totals on the parent's connection, and without this scope the child's
 * figure overwrote the root's under the same `agentPath []` key.
 */

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

/** The latest reasoning-effort level the runtime reported for the root agent; null before any. */
export function effortOf(records: readonly RawEvent[], sessionId?: string): QueryResult<string | null> {
  let value: string | null = null;
  let seq = -1;
  for (const record of records) {
    if (!inSession(record, sessionId)) { continue; }
    seq = record.seq;
    if (record.kind === "frame" && record.agentPath.length === 0) {
      const event = record.body.events.findLast((candidate) => candidate.kind === "effort");
      if (event?.kind === "effort") { value = event.effort; }
    }
  }
  return { value, seq };
}

/** The latest service tier the runtime reported for the root agent; null before any. */
export function serviceTierOf(records: readonly RawEvent[], sessionId?: string): QueryResult<string | null> {
  let value: string | null = null;
  let seq = -1;
  for (const record of records) {
    if (!inSession(record, sessionId)) { continue; }
    seq = record.seq;
    if (record.kind === "frame" && record.agentPath.length === 0) {
      const event = record.body.events.findLast((candidate) => candidate.kind === "service_tier");
      if (event?.kind === "service_tier") { value = event.serviceTier; }
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
 * LATEST figure its records reported (adapters resolve their runtime's
 * accounting into a running total per agent, counted from when this Session
 * opened, before the record is stamped), so the breakdown is deduplicated by
 * construction; with the runtime's own session total, when it reports one,
 * the breakdown plus `unattributed` sums to the total. Agents are the
 * `agentPath`s of THIS session; derived child sessions are not agents of it.
 * The graph defaults to graphOf(records); an explicit graph overrides it.
 * Each derived child session's total (folded from
 * its own records the same way) is added once into `withChildren`, and the
 * answer's `seq` covers those records too.
 */
export function usageOf(records: readonly RawEvent[], sessionId?: string, graph?: SessionGraph): QueryResult<SessionUsage> {
  const lineage = graph ?? graphOf(records);
  const children = sessionId === undefined ? new Set<string>() : derivedFrom(lineage, sessionId);
  const sessions = new Map<string, SessionTokens>();
  let seq = -1;
  for (const record of records) {
    const related = inSession(record, sessionId) || children.has(record.sessionId);
    const linked = record.kind === "frame" && record.body.events.some((event) =>
      event.kind === "session_linked" && children.has(event.child) && (event.parent === sessionId || children.has(event.parent)));
    if (related || linked) { seq = record.seq; }
    if (!related) { continue; }
    if (record.kind !== "frame") {
      continue;
    }
    // Unscoped, every session folds into one (the collision the scope exists to avoid).
    const key = sessionId === undefined ? "" : record.sessionId;
    for (const event of record.body.events) {
      if (event.kind !== "usage") { continue; }
      sessions.set(key, foldSessionTokens(sessions.get(key), record.agentPath, event.usage));
    }
  }
  return { value: usageFromSessions(sessions, sessionId ?? "", sessionId === undefined ? { nodes: [], edges: [] } : lineage), seq };
}
