import type {
  ContextUsage,
  QueryResult,
  RawEvent,
  SessionGraph,
  SessionUsage,
  TokenTotals,
} from "../contracts/session.js";
import { addTokens, noTokens, subtractTokens } from "../shared/token-totals.js";

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

/** One agent's latest running total. */
interface AgentTotal {
  readonly agentPath: readonly string[];
  readonly tokens: TokenTotals;
}

/** What one session's records said about tokens: each agent's latest running total, and the runtime's own session total when it reports one. */
interface SessionTokens {
  readonly agents: Map<string, AgentTotal>;
  total: TokenTotals | null;
}

function hasTokens(tokens: TokenTotals): boolean {
  return tokens.input > 0 || tokens.output > 0;
}

/**
 * A session's usage from each agent's latest running total and, where the
 * runtime reports one beyond its agents' figures (claude's `modelUsage`), its
 * own session total: then the total is the runtime's, and what no agent
 * accounts for is `unattributed`, the difference, never split by estimate.
 * Elsewhere the agents' figures sum to the total. Shared by `usageOf` and the
 * session view.
 */
export function sessionUsageFrom(byAgent: readonly AgentTotal[], reported: TokenTotals | null): SessionUsage {
  if (byAgent.length === 0 && reported === null) {
    // Nothing reported yet (or a runtime whose interface never carries token
    // totals): null, never a guessed zero.
    return { total: null };
  }
  // A cache part is in the total once any agent reported it, summed over those that did.
  const attributed = byAgent.reduce<TokenTotals>((sum, entry) => addTokens(sum, entry.tokens), noTokens);
  const remainder = reported === null ? null : subtractTokens(reported, attributed);
  const unattributed = remainder !== null && hasTokens(remainder) ? remainder : null;
  const onlyRoot = byAgent.length <= 1 && byAgent.every((entry) => entry.agentPath.length === 0);
  return {
    total: reported ?? attributed,
    ...(onlyRoot && unattributed === null ? {} : { byAgent }),
    ...(unattributed === null ? {} : { unattributed }),
  };
}

/** Every session derived from `sessionId` in the graph, nested ones too, each once; never `sessionId` itself. */
function derivedFrom(graph: SessionGraph, sessionId: string): ReadonlySet<string> {
  const found = new Set<string>();
  const queue = [sessionId];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const edge of graph.edges) {
      if (edge.parent === parent && edge.child !== sessionId && !found.has(edge.child)) {
        found.add(edge.child);
        queue.push(edge.child);
      }
    }
  }
  return found;
}

/**
 * Session total plus a per-agent breakdown. Each agent's totals are the
 * LATEST figure its records reported (adapters resolve their runtime's
 * accounting into a running total per agent, counted from when this Session
 * opened, before the record is stamped), so the breakdown is deduplicated by
 * construction; with the runtime's own session total, when it reports one,
 * the breakdown plus `unattributed` sums to the total. Agents are the
 * `agentPath`s of THIS session; derived child sessions are not agents of it.
 * Given the session graph, each derived child session's total (folded from
 * its own records the same way) is added once into `withChildren`, and the
 * answer's `seq` covers those records too.
 */
export function usageOf(records: readonly RawEvent[], sessionId?: string, graph?: SessionGraph): QueryResult<SessionUsage> {
  const children = sessionId === undefined || graph === undefined ? new Set<string>() : derivedFrom(graph, sessionId);
  const sessions = new Map<string, SessionTokens>();
  let seq = -1;
  for (const record of records) {
    if (!inSession(record, sessionId) && !children.has(record.sessionId)) { continue; }
    seq = record.seq;
    if (record.kind !== "frame") {
      continue;
    }
    // Unscoped, every session folds into one (the collision the scope exists to avoid).
    const key = sessionId === undefined ? "" : record.sessionId;
    const session = sessions.get(key) ?? { agents: new Map(), total: null };
    sessions.set(key, session);
    for (const event of record.body.events) {
      if (event.kind !== "usage") { continue; }
      if (event.usage.tokens !== undefined) {
        session.agents.set(pathKey(record.agentPath), { agentPath: record.agentPath, tokens: event.usage.tokens });
      }
      if (event.usage.total !== undefined) {
        session.total = event.usage.total;
      }
    }
  }
  const usageOfSession = (id: string): SessionUsage => {
    const session = sessions.get(id);
    return session === undefined ? { total: null } : sessionUsageFrom([...session.agents.values()], session.total);
  };
  const own = usageOfSession(sessionId ?? "");
  const childTotals = [...children].flatMap((child) => usageOfSession(child).total ?? []);
  if (own.total === null || childTotals.length === 0) {
    return { value: own, seq };
  }
  return { value: { ...own, withChildren: childTotals.reduce<TokenTotals>((sum, tokens) => addTokens(sum, tokens), own.total) }, seq };
}
