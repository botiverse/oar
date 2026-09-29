import type { AppAsk, AppDecision, AskChoice, RejectionCode, RequestRecord } from "../contracts/session.js";

/*
 * Runtime→app requests and the host's answer: the runtime-independent half
 * of `Session.answer` (docs/spec/approvals.md). The kernel records and
 * checks; an adapter only turns a decision the request takes into the
 * runtime's own reply (its `DeliverAnswer`).
 */

/** What an adapter made of a decision: the reply it sent (recorded verbatim as the request's `answered` response), or why it sent none (the request stays open). */
export type AnswerDelivery =
  | { readonly kind: "sent"; readonly native: unknown }
  | { readonly kind: "rejected"; readonly code: RejectionCode; readonly reason: string };

/**
 * Send the runtime's reply for `decision` to the open request `request`,
 * synchronously (a write to the runtime's stdin, a resolved JSON-RPC
 * handler). Called only with a decision the request's `ask` takes, or a
 * `native` one.
 */
export type DeliverAnswer = (request: RequestRecord, decision: AppDecision) => AnswerDelivery;

/** The ask recorded on a `toApp` request, if oar read one. */
export function askOf(request: RequestRecord): AppAsk | undefined {
  return request.body.kind === "native" ? request.body.ask : undefined;
}

function choiceOf(decision: AppDecision): AskChoice | null {
  switch (decision.kind) {
    case "allow":
      return decision.scope === "session" ? "allow_session" : "allow";
    case "deny":
      return "deny";
    case "answer":
      return "answer";
    case "native":
      return null;
  }
  return null;
}

/**
 * Why `decision` cannot answer a request asking `ask`, or null when it can:
 * the same check for every adapter, read off the recorded ask. A `native`
 * decision is the runtime's own payload and always goes through.
 */
export function decisionRefusal(ask: AppAsk | undefined, decision: AppDecision): { readonly code: RejectionCode; readonly reason: string } | null {
  const choice = choiceOf(decision);
  if (choice === null) {
    return null;
  }
  if (ask === undefined) {
    return { code: "unsupported", reason: `this request is no approval or question oar can read; answer it with a native reply` };
  }
  if (!ask.choices.includes(choice)) {
    return { code: "unsupported", reason: `this ${ask.kind} takes ${ask.choices.join(", ")}, not ${choice}` };
  }
  if (decision.kind === "deny" && decision.message !== undefined && !ask.denyMessage) {
    return { code: "unsupported", reason: "this runtime carries no deny message to the model; deny without one" };
  }
  return null;
}

/** A question's answer as the list of chosen labels or free text. */
export function answerList(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return typeof value === "string" ? [value] : value;
}
