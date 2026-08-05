/**
 * Chapter 3b -- INTERCEPTION. Split from observation (3a) on one question:
 *
 *   > Can the consumer say no?
 *
 * Observation reports what happened; the host reads, records, displays, and
 * cannot change it. Interception means the host's answer CHANGES WHAT HAPPENS
 * NEXT. Their contracts share nothing: interception must specify a latency
 * budget, what a timeout defaults to, and ordering guarantees. Observation
 * needs none of it.
 *
 * Merging them hides exactly the security-relevant question, which is why they
 * are separate files rather than separate fields.
 */

export interface ToolCallRequest {
  readonly callId: string;
  readonly name: string;
}

/** The host's answer. `deny` carries a reason so a refusal is never silent. */
export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

/**
 * What happens when the host does not answer in time.
 *
 * ⚠️ There is no default. A timeout policy that silently means `allow` is how
 * an approval gate becomes decoration, and one that silently means `deny` is
 * how a runtime mysteriously stalls. The implementor must state which, so the
 * choice appears in review rather than in an incident.
 */
export interface InterceptPolicy {
  readonly budgetMs: number;
  readonly onTimeout: Decision;
}

export interface Interceptor {
  decide(request: ToolCallRequest): Promise<Decision>;
}
