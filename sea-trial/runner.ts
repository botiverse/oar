import type { Capabilities } from "../src/capability.js";
import type { IdleSession } from "../src/session/handle.js";

/**
 * `sea-trial` — the conformance suite every runtime passes.
 *
 * The suite's whole value rests on one rule: a case may be skipped ONLY when
 * the skip maps to a capability the runtime declared it lacks.
 *
 * > An undeclared skip is a failure.
 *
 * Without that, this stops being one conformance suite and becomes N suites
 * each passing its own subset -- the "N special cases sharing a directory"
 * outcome the project exists to avoid. So the rule is not documented here and
 * left to reviewers: `skipped` cannot be constructed without naming the
 * capability that justified it, and only `runCase` can produce one, from the
 * runtime's own declaration. Skipping is derived, never asserted.
 */

/** Cases assert on protocol-observable facts, never on what the model said. */
export interface TrialCase {
  readonly id: string;
  /** Capabilities this case needs. A runtime lacking any of them skips it. */
  readonly requires: readonly (keyof Capabilities)[];
  /**
   * Throw to fail. The thrown message is the failure reason, so a case cannot
   * report failure without saying what failed.
   */
  run(session: IdleSession): Promise<void>;
}

/**
 * Three outcomes, not two.
 *
 * Vendor CLIs change constantly. If every vendor update turns the board red the
 * suite gets muted, and a muted suite is worse than none because it still looks
 * like coverage. DRIFT goes to human triage, ending in one of: amend the
 * contract, re-record, or promote to FAIL.
 */
export type Outcome =
  | { readonly kind: "pass"; readonly caseId: string }
  | { readonly kind: "fail"; readonly caseId: string; readonly reason: string }
  | { readonly kind: "drift"; readonly caseId: string; readonly recorded: string; readonly observed: string }
  /**
   * `missing` is a NON-EMPTY tuple, so "skipped, but nothing was missing" does
   * not typecheck. This is the tooth behind "an undeclared skip is a failure":
   * a comment saying so would be a label asserting a property nothing enforces.
   *
   * Honest limit: the type forbids an EMPTY justification, it cannot force the
   * named capability to be genuinely absent. `runCase` derives it from the
   * runtime's declaration, and that derivation -- not this type -- is what
   * makes the named capability true.
   */
  | {
      readonly kind: "skipped";
      readonly caseId: string;
      readonly missing: readonly [keyof Capabilities, ...(keyof Capabilities)[]];
    };

/**
 * The intended producer of an `Outcome`.
 *
 * A skip is computed from the runtime's DECLARED capabilities rather than
 * chosen by the case, so "skipped because it was inconvenient" has no path
 * through here.
 *
 * Honest limit, stated because the opposite claim would be an unenforced
 * label: `Outcome` is a plain union, so nothing stops a caller hand-building
 * one. What is enforced is the SHAPE (a skip must name at least one
 * capability); what is conventional is that results come from this function.
 * Closing that gap needs a branded type, which is not earned yet.
 */
export async function runCase(trialCase: TrialCase, session: IdleSession): Promise<Outcome> {
  const missing = trialCase.requires.filter((required) => !session.capabilities[required]);
  const [first, ...rest] = missing;
  if (first !== undefined) {
    return { kind: "skipped", caseId: trialCase.id, missing: [first, ...rest] };
  }
  try {
    await trialCase.run(session);
    return { kind: "pass", caseId: trialCase.id };
  } catch (error) {
    return {
      kind: "fail",
      caseId: trialCase.id,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A suite is honest only if it reports how much of itself it did not run.
 *
 * A suite that silently runs fewer cases than it used to is the exact
 * silent-failure shape this project ranks highest, so the count of skips is
 * part of the result rather than something a reader must notice.
 */
export interface SuiteResult {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly drifted: number;
  readonly skipped: number;
  readonly outcomes: readonly Outcome[];
}

export function summarise(outcomes: readonly Outcome[]): SuiteResult {
  let passed = 0;
  let failed = 0;
  let drifted = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case "pass": passed += 1; break;
      case "fail": failed += 1; break;
      case "drift": drifted += 1; break;
      case "skipped": skipped += 1; break;
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled outcome: ${String(unhandled)}`);
      }
    }
  }
  return { total: outcomes.length, passed, failed, drifted, skipped, outcomes };
}
