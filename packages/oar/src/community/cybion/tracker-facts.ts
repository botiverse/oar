import type { TurnOutcome } from "../../contracts/records.js";
import type { CybionThread, CybionUsage } from "./thread.js";

/*
 * What one read of a Thread says, in oar's terms: the usage this session has to
 * report and how a Thread that stopped running ended. Pure functions over
 * Cybion's own shapes, so tracker.ts keeps to the polling itself.
 */

/** The Thread's totals less the ones it already carried when this session opened. */
export function totalsSince(now: CybionUsage, opened: CybionUsage): CybionUsage {
  return {
    input: Math.max(0, now.input - opened.input),
    output: Math.max(0, now.output - opened.output),
    cacheRead: Math.max(0, now.cacheRead - opened.cacheRead),
  };
}

export function sameUsage(left: CybionUsage, right: CybionUsage): boolean {
  return left.input === right.input && left.output === right.output && left.cacheRead === right.cacheRead;
}

/** How a Thread that stopped running ended, from Cybion's own status words. */
export function outcomeOf(thread: CybionThread): TurnOutcome {
  if (thread.displayStatus === "stopped") {
    return { kind: "aborted" };
  }
  if (thread.status === "failed") {
    return { kind: "failed", failure: "unknown", reason: "the Cybion Thread failed; its own history holds the reason" };
  }
  if (thread.displayStatus === "blocked") {
    return { kind: "failed", failure: "unknown", reason: "the Cybion Thread is blocked on its owner" };
  }
  return { kind: "completed" };
}
