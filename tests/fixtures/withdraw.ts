/* oxlint-disable import/prefer-default-export -- fixtures export names, like the package. */
import assert from "node:assert/strict";
import type { ControlOutcome, Session } from "../../packages/oar/src/contracts/session.js";

/**
 * Withdraw from a session the test expects to withdraw from, answered as one
 * word: `accepted`, or the rejection code. A session without `withdraw`
 * fails the test, it is never skipped.
 */
export async function withdraw(session: Session, inputId: string): Promise<string> {
  assert.ok(session.withdraw !== undefined, "this session has no withdraw");
  const outcome: ControlOutcome = await session.withdraw(inputId);
  assert.equal(outcome.request.body.kind, "withdraw");
  return outcome.kind === "accepted" ? "accepted" : outcome.code;
}

/** The inputId a queue (or any input) request carried; sealSession always sets one. */
export function inputIdOf(outcome: ControlOutcome): string {
  const { body } = outcome.request;
  assert.ok("inputId" in body, "the request carries an inputId");
  return body.inputId;
}
