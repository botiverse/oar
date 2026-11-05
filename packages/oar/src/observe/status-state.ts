import type { AgentStatus, TurnOutcome } from "../contracts/session.js";
import type { AdapterQueueState } from "./adapter-queue.js";
import type { InputAdmission } from "./input-admission.js";

/**
 * Serializable checkpoint returned by `reduceStatus`, exported from
 * `@botiverse/oar/observe` and the root entry. To resume an incremental fold,
 * persist this entire value unchanged together with the last consumed cursor.
 * Saving only AgentStatus fields loses native operation correlation.
 * Use `statusValue` for display, never as the checkpoint for resuming a fold.
 */
export type StatusState = AgentStatus & { readonly inputAdmission?: InputAdmission; readonly adapterQueue?: AdapterQueueState; readonly compactionState?: {
  readonly nativeTurn?: true;
  readonly settledBy?: "native_response";
  /** Learned from the native manual start during this exclusive idle operation. */
  readonly compactionId?: string;
  readonly spanId?: string;
  readonly lastTurnOutcome?: TurnOutcome;
} };
/** Start a new fold; use a saved StatusState when continuing after a cursor. */
export const initialStatus: StatusState = { kind: "idle" };

/** Separate display state from the checkpoint needed by incremental folds. */
export function statusValue(state: StatusState): AgentStatus {
  const { compactionState: _compactionState, adapterQueue: _adapterQueue, inputAdmission: _inputAdmission, ...value } = state;
  return value;
}
