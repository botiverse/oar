import type { RuntimeUnderTest } from "./subject.js";
import { record } from "./trace.js";
import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";

export type RuntimeCapability = Exclude<keyof Runtime, "id">;

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
      readonly missing: readonly [RuntimeCapability, ...RuntimeCapability[]];
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
