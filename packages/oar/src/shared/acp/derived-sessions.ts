import type { SessionEdge } from "../../contracts/graph.js";
import type { SessionOptions } from "../../contracts/session.js";
import type { JsonRecord } from "../json.js";

/** What a vendor extension notification says about one derived (child) session. */
export interface AcpChildNotification {
  /** The derived session the notification is about. */
  readonly sessionId: string;
  /** Its parent session, as the runtime names it. A claim only: the graph edge also needs `spawnedSessions` evidence. */
  readonly parent: string;
  /**
   * The derived session's own standard session update, projected exactly as its
   * `session/update` would be and recorded under `sessionId`. Null for a lifecycle
   * report, which is recorded on the parent's envelope with `projectExtension` events.
   */
  readonly update: JsonRecord | null;
}

/** Profile hooks for runtimes that report derived sessions outside the standard update channel. */
export interface AcpDerivedSessionHooks {
  /** Vendor client features merged into `initialize`'s `clientCapabilities._meta`. */
  readonly clientCapabilitiesMeta?: (options: SessionOptions) => JsonRecord | undefined;
  /**
   * Read an extension notification about a derived session. Once one names a child,
   * that child's attributed standard updates stay verbatim without events, so one
   * native update is never projected twice.
   */
  readonly childNotification?: (method: string, params: JsonRecord) => AcpChildNotification | null;
  /** Child session ids a tool call update reports it started (the spawning tool's own output). */
  readonly spawnedSessions?: (update: JsonRecord) => readonly string[];
}

/**
 * Edges proven by two native facts: a child notification naming its parent, and a
 * tool call in that same parent session reporting the child it started. Either may
 * arrive first; neither alone is an edge.
 */
export interface AcpChildLineage {
  claim(child: string, parent: string): readonly SessionEdge[];
  spawned(session: string, children: readonly string[]): readonly SessionEdge[];
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

export function createAcpChildLineage(): AcpChildLineage {
  const claims = new Map<string, Set<string>>();
  const spawners = new Map<string, Set<string>>();
  return {
    claim(child, parent) {
      if (child === parent) { return []; }
      add(claims, child, parent);
      return spawners.get(child)?.has(parent) === true ? [{ parent, child, via: "tool_call" }] : [];
    },
    spawned(session, children) {
      return children.flatMap((child) => {
        if (child === session) { return []; }
        add(spawners, child, session);
        return claims.get(child)?.has(session) === true ? [{ parent: session, child, via: "tool_call" as const }] : [];
      });
    },
  };
}
