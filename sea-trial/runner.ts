import type { RuntimeUnderTest } from "../drydock/runner.js";
import type { Runtime } from "../src/contracts/runtime.js";

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
  try {
    await testCase.run(subject);
    return { kind: "pass", caseId: testCase.id };
  } catch (error) {
    return {
      kind: "fail",
      caseId: testCase.id,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runSuite(
  cases: readonly TrialCase[],
  subject: RuntimeUnderTest,
): Promise<readonly Outcome[]> {
  return Promise.all(cases.map(async (testCase) => runCase(testCase, subject)));
}
