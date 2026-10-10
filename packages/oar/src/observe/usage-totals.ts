import type { SessionGraph, SessionUsage, TokenTotals, UsageReport } from "../contracts/session.js";
import { addTokens, noTokens, subtractTokens } from "../shared/token-totals.js";

/** One agent's latest running total. */
export interface AgentTotal {
  readonly agentPath: readonly string[];
  readonly tokens: TokenTotals;
}

/** What one session's records said about tokens: each agent's latest running total, and the runtime's own session total when it reports one. */
export interface SessionTokens {
  readonly agents: ReadonlyMap<string, AgentTotal>;
  readonly total: TokenTotals | null;
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
export function derivedFrom(graph: SessionGraph, sessionId: string): ReadonlySet<string> {
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

/** Latest totals per agent, without mutating a previously published view. */
export function foldSessionTokens(previous: SessionTokens | undefined, agentPath: readonly string[], usage: UsageReport): SessionTokens {
  const agents = new Map(previous?.agents);
  if (usage.tokens !== undefined) {
    agents.set(JSON.stringify(agentPath), { agentPath, tokens: usage.tokens });
  }
  return { agents, total: usage.total ?? previous?.total ?? null };
}

/** Own usage and each reachable child's latest total, shared by query and view. */
export function usageFromSessions(sessions: ReadonlyMap<string, SessionTokens>, sessionId: string, graph: SessionGraph): SessionUsage {
  const ofSession = (id: string): SessionUsage => {
    const session = sessions.get(id);
    return session === undefined ? { total: null } : sessionUsageFrom([...session.agents.values()], session.total);
  };
  const own = ofSession(sessionId);
  const childTotals = [...derivedFrom(graph, sessionId)].flatMap((child) => ofSession(child).total ?? []);
  return own.total === null || childTotals.length === 0 ? own
    : { ...own, withChildren: childTotals.reduce<TokenTotals>((sum, tokens) => addTokens(sum, tokens), own.total) };
}
