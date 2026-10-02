import type { ControlOutcome, InputOptions } from "./session.js";
import type { RejectionCode } from "./records.js";

/**
 * When a delivered input should reach the agent.
 * `now`: into the running turn (steered, or queued when the runtime cannot
 * steer), or a new turn when the session is idle, so an idle agent wakes.
 * `after_turn`: after the running turn (queued, or held until idle when the
 * runtime holds no queue), or a new turn when idle.
 * `when_idle`: once the session is idle, as a new turn.
 */
export type DeliverWhen = "now" | "after_turn" | "when_idle";

export interface DeliverOptions extends InputOptions {
  readonly when?: DeliverWhen;
}

/**
 * Where the input landed. Every attempt carries the same `inputId`, so the
 * conversation projection joins them and shows when the runtime echoed the
 * input back. `rejected` means no attempt was taken over and the caller
 * still owns the input.
 */
export type DeliverResult =
  | { readonly landed: "prompted" | "steered" | "queued"; readonly inputId: string; readonly result: ControlOutcome }
  /** `result` is the last refused control; absent when the session changed state on every attempt and none was made to stick. */
  | { readonly landed: "rejected"; readonly inputId: string; readonly code: RejectionCode; readonly reason: string; readonly result?: ControlOutcome };
