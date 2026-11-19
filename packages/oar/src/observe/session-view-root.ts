import type { RawEvent, Event, RuntimeEventBody, SessionGraph } from "../contracts/session.js";
import { graphOf, withSessionLink, withSessionNode } from "./graph.js";
import { sealTurn, type Draft } from "./session-view-fold.js";

/** Follow recorded ancestry only while it identifies a single parent. */
function lineageRoot(graph: SessionGraph, member: string): string {
  let current = member;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const child = current;
    const parents = graph.edges.filter(edge => edge.child === child);
    if (parents.length !== 1 || parents[0] === undefined) { break; }
    current = parents[0].parent;
  }
  return current;
}

export function rootEvidence(record: RawEvent): "open" | "prompt" | undefined {
  if (record.agentPath.length > 0) { return undefined; }
  if (record.kind === "response" && record.body.kind === "opened") { return "open"; }
  if (record.kind === "request" && record.direction === "toRuntime" && (record.body.kind === "open" || record.body.kind === "prompt")) {
    return record.body.kind;
  }
  return undefined;
}

/** Find the publishing session before projecting a retained stream whose first frame can belong to a child. */
export function recordedRoot(records: readonly RawEvent[]): string | undefined {
  const opened = records.find(record => rootEvidence(record) === "open");
  if (opened !== undefined) { return opened.sessionId; }
  const first = records.find(record => rootEvidence(record) === "prompt")?.sessionId ?? records[0]?.sessionId;
  return first === undefined ? undefined : lineageRoot(graphOf(records), first);
}

/** A host-provided root is authoritative. Unseeded single-session views can be corrected by later native evidence. */
export function prepareViewRoot(draft: Draft, id: string, evidence: "open" | "prompt" | undefined, events: readonly (RuntimeEventBody | Event)[]): void {
  draft.sessionGraph = withSessionNode(draft.sessionGraph, id);
  const before = draft.sessionGraph;
  for (const event of events) {
    if (event.kind === "session_linked") { draft.sessionGraph = withSessionLink(draft.sessionGraph, event); }
  }
  if (draft.rootProvided) { return; }
  const previous = draft.rootSessionId;
  let root = previous ?? id;
  if (evidence !== undefined) { root = id; }
  if (evidence !== "open" && (evidence === "prompt" || before !== draft.sessionGraph)) { root = lineageRoot(draft.sessionGraph, root); }
  draft.rootSessionId = root;
  if (previous !== undefined && previous !== root) {
    draft.model = null;
    draft.effort = null;
    draft.context = null;
    draft.serviceTier = null;
    draft.exited = null;
    sealTurn(draft);
  }
}
