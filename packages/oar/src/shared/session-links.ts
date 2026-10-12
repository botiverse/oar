/* oxlint-disable import/prefer-default-export -- Named helper shared by ACP and Codex recorders. */
import type { RuntimeEventBody, SessionEdge } from "../contracts/session.js";
import type { SessionKernel } from "./session-kernel.js";

/** Add lineage to its first source frame, including at most one copy within that frame. */
export function newSessionLinks(kernel: SessionKernel, edges: readonly SessionEdge[]): Extract<RuntimeEventBody, { readonly kind: "session_linked" }>[] {
  const known = kernel.graph().edges;
  const added: Extract<RuntimeEventBody, { readonly kind: "session_linked" }>[] = [];
  for (const edge of edges) {
    const same = (candidate: SessionEdge): boolean => candidate.parent === edge.parent && candidate.child === edge.child;
    if (!known.some((candidate) => same(candidate)) && !added.some((candidate) => same(candidate))) { added.push(kernel.link(edge)); }
  }
  return added;
}
