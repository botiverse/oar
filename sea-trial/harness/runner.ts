import type { RuntimeUnderTest } from "./subject.js";
import { record } from "./trace.js";
import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";

export type RuntimeCapability = Exclude<keyof Runtime, "id">;
/** A whole operation a session may lack: its presence is the capability. */
type SessionMember = "steer" | "withdraw";
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

/** The session's `withdraw`; a session without one (codex) is disposed and the case skips on that capability. */
export async function withdrawOrSkip(session: Session): Promise<NonNullable<Session["withdraw"]>> {
  const withdraw = session.withdraw?.bind(session);
  if (withdraw === undefined) {
    await session.dispose();
    throw new SessionLacksError("withdraw");
  }
  return withdraw;
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

/** A failed assertion must release its processes before the fixture removes their cwd. */
async function runWithCleanup(testCase: TrialCase, subject: RuntimeUnderTest): Promise<void> {
  const sessions = new Set<Session>();
  let failed = false;
  let failure: unknown = undefined;
  try {
    await testCase.run({ ...subject, startSession: async (options) => {
      const session = await subject.startSession(options);
      sessions.add(session);
      return session;
    } });
  } catch (error) { failed = true; failure = error; }
  const cleanup = await Promise.allSettled([...sessions].map(async (session) => { await session.dispose(); }));
  if (failed) { throw failure; }
  const rejected = cleanup.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") { throw rejected.reason; }
}

export async function runCase(testCase: TrialCase, subject: RuntimeUnderTest): Promise<Outcome> {
  const missing = testCase.requires.filter((capability) => subject.runtime[capability] === undefined);
  const first = missing[0];
  if (first !== undefined) {
    return { kind: "skipped", caseId: testCase.id, missing: [first, ...missing.slice(1)] };
  }
  record({ kind: "case_started", caseId: testCase.id });
  try {
    await runWithCleanup(testCase, subject);
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
  concurrency = cases.length || 1,
): Promise<readonly Outcome[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) { throw new RangeError("test concurrency must be a positive integer"); }
  const outcomes: Outcome[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (next < cases.length) {
      const index = next++;
      const testCase = cases[index];
      if (testCase !== undefined) { outcomes[index] = await runCase(testCase, subject); }
    }
  }));
  return outcomes;
}
