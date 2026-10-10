import type { RawEvent, SessionEdge, SessionGraph } from "../contracts/session.js";

/** Record envelopes establish nodes, even when the runtime gave no lineage. */
export function withSessionNode(graph: SessionGraph, id: string): SessionGraph {
  return graph.nodes.some((node) => node.id === id) ? graph : { ...graph, nodes: [...graph.nodes, { id }] };
}

/** The same native edge may be reported many times; the graph contains it once. */
export function withSessionLink(graph: SessionGraph, edge: SessionEdge): SessionGraph {
  const nodes = withSessionNode(withSessionNode(graph, edge.parent), edge.child);
  return nodes.edges.some((known) => known.parent === edge.parent && known.child === edge.child)
    ? nodes : { ...nodes, edges: [...nodes.edges, { parent: edge.parent, child: edge.child, via: edge.via }] };
}

/**
 * True sessions observed in records, with only runtime-reported lineage.
 * Foreign session ids establish nodes, never edges. Old logs without
 * `session_linked` therefore have no edges; an empty log has no nodes.
 */
export function graphOf(records: readonly RawEvent[]): SessionGraph {
  let graph: SessionGraph = { nodes: [], edges: [] };
  for (const record of records) {
    graph = withSessionNode(graph, record.sessionId);
    if (record.kind !== "frame") { continue; }
    for (const event of record.body.events) {
      if (event.kind === "session_linked") { graph = withSessionLink(graph, event); }
    }
  }
  return graph;
}
