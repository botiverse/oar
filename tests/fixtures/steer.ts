/* oxlint-disable import/prefer-default-export -- fixtures export names, like the package. */
import assert from "node:assert/strict";
import type { ControlOutcome, InputOptions, Session } from "../../packages/oar/src/contracts/session.js";

/** Steer a session the test expects to steer: a session without `steer` fails the test, it is never skipped. */
export async function steer(session: Session, input: string, options?: InputOptions): Promise<ControlOutcome> {
  assert.ok(session.steer !== undefined, "this session has no steer");
  return session.steer(input, options);
}
