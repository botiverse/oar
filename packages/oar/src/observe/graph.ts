import type { RawEvent, SessionEdge, SessionGraph } from "../contracts/session.js";

/** Record envelopes establish nodes. A retained index avoids scanning nodes in long-lived folds. */
export function withSessionNode(graph: SessionGraph, id: string, nodeIds?: Set<string>): SessionGraph {
  if (nodeIds?.has(id) ?? graph.nodes.some((node) => node.id === id)) { return graph; }
  nodeIds?.add(id);
  return { ...graph, nodes: [...graph.nodes, { id }] };
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

/** The same native edge may be reported many times; the graph contains it once. */
export function withSessionLink(graph: SessionGraph, edge: SessionEdge, nodeIds?: Set<string>): SessionGraph {
  const nodes = withSessionNode(withSessionNode(graph, edge.parent, nodeIds), edge.child, nodeIds);
  return edge.parent === edge.child || nodes.edges.some((known) => known.parent === edge.parent && known.child === edge.child)
    || derivedFrom(nodes, edge.child).has(edge.parent)
    ? nodes : { ...nodes, edges: [...nodes.edges, { parent: edge.parent, child: edge.child, via: edge.via }] };
}

/** One record's graph facts, shared by the retained live graph and batch replay. */
export function withSessionRecord(graph: SessionGraph, record: RawEvent, nodeIds: Set<string>): SessionGraph {
  let next = withSessionNode(graph, record.sessionId, nodeIds);
  if (record.kind === "frame") {
    for (const event of record.body.events) {
      if (event.kind === "session_linked") { next = withSessionLink(next, event, nodeIds); }
    }
  }
  return next;
}

/**
 * True sessions observed in records, with only runtime-reported lineage.
 * Foreign session ids establish nodes, never edges. Old logs without
 * `session_linked` therefore have no edges; an empty log has no nodes.
 */
export function graphOf(records: readonly RawEvent[]): SessionGraph {
  let graph: SessionGraph = { nodes: [], edges: [] };
  const nodeIds = new Set<string>();
  for (const record of records) {
    graph = withSessionRecord(graph, record, nodeIds);
  }
  return graph;
}
