import type { ControlOutcome, InputOptions } from "./session.js";
import type { RejectionCode } from "./records.js";

/**
 * When a delivered input should reach the agent.
 * `now`: into the running turn (steered, or queued when the session has no
 * `steer`), or a new turn when the session is idle, so an idle agent wakes.
 * `after_turn`: after the running turn (queued), or a new turn when idle.
 * `when_idle`: once the session is idle, as a new turn.
 * `interrupt`: steer if available; otherwise withdraw and merge held inputs
 * after a bounded root-tool wait and the runtime's own turn end.
 */
export type DeliverWhen = "now" | "after_turn" | "when_idle" | "interrupt";

export interface DeliverMergeInput extends InputOptions {
  readonly inputId: string;
  readonly input: string;
}
export interface DeliverMergeResult {
  readonly input: string;
  readonly images?: InputOptions["images"];
}
export type DeliverOptions = InputOptions & (
  | { readonly when?: Exclude<DeliverWhen, "interrupt">; readonly maxWaitMs?: never; readonly merge?: never }
  | {
      readonly when: "interrupt";
      /** Maximum wait for root tools to finish, before aborting. Finite and nonnegative. */
      readonly maxWaitMs: number;
      /** Synchronous merge in queue order. The first concurrent interrupt supplies the merger. */
      readonly merge?: (inputs: readonly DeliverMergeInput[]) => DeliverMergeResult;
    }
);

/**
 * Where the input landed. Every attempt carries the same `inputId`, so the
 * conversation projection joins them and shows when the runtime echoed the
 * input back. `rejected` leaves the input with the caller, including a
 * formerly queued input taken back by interrupt delivery. That failure's
 * `undeliveredInputIds` also names earlier inputs returned to the caller.
 */
export type DeliverResult =
  | { readonly landed: "prompted" | "steered" | "queued"; readonly inputId: string; readonly result: ControlOutcome; readonly mergedInputIds?: readonly string[]; readonly undeliveredInputIds?: readonly string[] }
  /** `result` is the last refused control; absent when the session changed state on every attempt and none was made to stick. */
  | { readonly landed: "rejected"; readonly inputId: string; readonly code: RejectionCode; readonly reason: string; readonly result?: ControlOutcome; readonly undeliveredInputIds?: readonly string[] };
