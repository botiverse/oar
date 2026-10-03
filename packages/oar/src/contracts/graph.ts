// ─── Session graph and cursor ─────────────────────────────────────────────
// Semantics: docs/spec/session-graph-and-cursor.md. Re-exported by ./records.ts.

/** True sessions only (docs/spec/session-graph-and-cursor.md): derived child sessions and transcript branches. Agent parent/child is `agentPath`, not a node. */
export interface SessionNode {
  readonly id: string;
}

export interface SessionEdge {
  readonly parent: string;
  readonly child: string;
  readonly via: "tool_call";
}

export interface SessionGraph {
  readonly nodes: readonly SessionNode[];
  readonly edges: readonly SessionEdge[];
}

/** Resume reading after `afterSeq`; `-1` (or omitting the cursor) reads from the start. */
export interface Cursor {
  readonly sessionId: string;
  readonly afterSeq: number;
}
