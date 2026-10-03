import type { RuntimeUnderTest } from "./subject.js";
import { record } from "./trace.js";
import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";

export type RuntimeCapability = Exclude<keyof Runtime, "id">;
/** A whole operation a session may lack: its presence is the capability. */
type SessionMember = "steer";
type Missing = RuntimeCapability | SessionMember;

/**
 * Thrown by a case whose opened session lacks a member it needs, so the case
 * skips by capability (`session.steer === undefined`), never by runtime name.
 */
class SessionLacksError extends Error {
  override readonly name = "SessionLacksError";
  readonly member: SessionMember;

  constructor(member: SessionMember) {
    super(`the session has no ${member}`);
    this.member = member;
  }
}

/** The session's `steer`; a session without one is disposed and the case skips on that capability. */
export async function steerOrSkip(session: Session): Promise<NonNullable<Session["steer"]>> {
  const steer = session.steer?.bind(session);
  if (steer === undefined) {
    await session.dispose();
    throw new SessionLacksError("steer");
  }
  return steer;
}

export interface TrialCase {
  readonly id: string;
  readonly requires: readonly RuntimeCapability[];
  run(subject: RuntimeUnderTest): Promise<void>;
}

export type Outcome =
  | { readonly kind: "pass"; readonly caseId: string }
  | { readonly kind: "fail"; readonly caseId: string; readonly reason: string }
  | {
      readonly kind: "skipped";
      readonly caseId: string;
      readonly missing: readonly [Missing, ...Missing[]];
    };

export async function runCase(testCase: TrialCase, subject: RuntimeUnderTest): Promise<Outcome> {
  const missing = testCase.requires.filter((capability) => subject.runtime[capability] === undefined);
  const first = missing[0];
  if (first !== undefined) {
    return { kind: "skipped", caseId: testCase.id, missing: [first, ...missing.slice(1)] };
  }
  record({ kind: "case_started", caseId: testCase.id });
  try {
    await testCase.run(subject);
    record({ kind: "case_passed", caseId: testCase.id });
    return { kind: "pass", caseId: testCase.id };
  } catch (error) {
    if (error instanceof SessionLacksError) {
      record({ kind: "case_skipped", caseId: testCase.id, missing: error.member });
      return { kind: "skipped", caseId: testCase.id, missing: [error.member] };
    }
    const reason = error instanceof Error ? error.message : String(error);
    record({ kind: "case_failed", caseId: testCase.id, reason });
    return { kind: "fail", caseId: testCase.id, reason };
  }
}

export async function runSuite(
  cases: readonly TrialCase[],
  subject: RuntimeUnderTest,
): Promise<readonly Outcome[]> {
  const outcomes = await Promise.all(cases.map(async (testCase) => {
    const outcome = await runCase(testCase, subject);
    return outcome;
  }));
  return outcomes;
}
