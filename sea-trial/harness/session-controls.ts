import assert from "node:assert/strict";
import type { ControlResult, Session, TurnOutcome } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";

/** Prompt and insist the runtime accepted it. */
export async function accepted(session: Session, input: string, options?: Parameters<Session["prompt"]>[1]): Promise<ControlResult> {
  const result = await session.prompt(input, options);
  assert.ok(result.response.body.kind === "accepted", `prompt ${JSON.stringify(input)} was not accepted: ${JSON.stringify(result.response.body)}`);
  return result;
}
export async function runTurn(session: Session, input: string): Promise<TurnOutcome> {
  const result = await accepted(session, input);
  return awaitTurnEnd(session, result.request.seq);
}
