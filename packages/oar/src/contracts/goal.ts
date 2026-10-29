import type { ControlOutcome, ControlResult } from "./control.js";

export type KnownGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
/** Known statuses autocomplete; new native statuses remain visible unchanged. */
export type GoalStatus = KnownGoalStatus | (string & Record<never, never>);

/** A native observation, never inferred from a completed turn or requested options. */
export interface GoalSnapshot {
  readonly objective: string;
  readonly status: GoalStatus;
  /** Missing means unreported; null is a reported absence of a token budget. */
  readonly tokenBudget?: number | null;
  readonly tokensUsed?: number;
  readonly timeUsedSeconds?: number;
  /** Native Unix epoch seconds, when reported. */
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface GoalSetOptions {
  readonly objective: string;
  /** Omission leaves the runtime's default or existing status in charge. */
  readonly status?: GoalStatus;
  /** Positive integer. Omission does not promise to clear a saved budget. */
  readonly tokenBudget?: number;
}

/** Every call records a request and its outcome; successful replies emit goal_changed. */
export interface AdapterGoalControl {
  set(options: GoalSetOptions): Promise<ControlResult>;
  read(): Promise<ControlResult>;
  clear(): Promise<ControlResult>;
}

/** Presence is the capability. Read observes now; events carry the native snapshot. */
export interface GoalControl extends AdapterGoalControl {
  set(options: GoalSetOptions): Promise<ControlOutcome>;
  read(): Promise<ControlOutcome>;
  clear(): Promise<ControlOutcome>;
}
