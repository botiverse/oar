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

export interface Turn {
  /** Stable within one followed turn: an abort compares it to the turn it stopped. */
  readonly id: number;
  readonly ended: PromiseWithResolvers<void>;
  /**
   * Records with an id past this one prove the Thread did work for this turn.
   * An input's own record sits AT it: recording the input is not the Thread
   * running, so it never counts as work. A steer moves it forward — the input
   * it wrote belongs to this turn, so the records it draws belong here too.
   */
  after: number;
  /** The Thread was observed running, or wrote a record after the input. */
  worked: boolean;
  quiet: number;
  startPolls: number;
  /**
   * The record of the newest steer whose input the Thread has not been seen
   * taking in yet, or null. Cybion accepts a steer into the running turn, so the
   * turn is that input's too: it cannot end until the Thread ran (`running`) or
   * wrote something past this record, whatever the status says meanwhile.
   */
  steerRecord: number | null;
}

export function observe(current: Turn, now: CybionThread): void {
  if (now.status === "running") {
    current.worked = true;
    current.quiet = 0;
    // The Thread runs, so it has taken in anything written into the turn.
    current.steerRecord = null;
    return;
  }
  if (current.worked) {
    current.quiet += 1;
    return;
  }
  current.startPolls += 1;
}
