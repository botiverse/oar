import type { TurnOutcome } from "./records.js";

/**
 * The root agent's status: a fold over the record stream (the reducer is
 * `observe/agent-status.ts`; `Session.status()` is that fold over the
 * session's retained records). Time-qualified judgments (stalled) stay
 * outside the type: they are fold × clock, provided by `stallOf`.
 */

export type RunningPhase =
  | "waiting_model"
  | "thinking"
  | "responding"
  | "compacting"
  /** `writing`: the runtime is still streaming the call's arguments (a `tool_call_input_delta` came, its complete `tool_call_input` not yet); absent once they are complete and for every call without streamed arguments. */
  | { readonly tool: string; readonly callId: string; readonly writing?: true };

/** Native queue evidence retained across an unrelated spontaneous turn. */
interface PendingPrompt {
  readonly inputId: string;
  readonly sinceSeq: number;
  readonly requestId?: string;
  readonly stop?: { readonly pendingAbortIds: readonly string[]; readonly abortedOnExit: boolean };
}

export type AgentStatus = (
  | { readonly kind: "idle"; readonly lastTurnOutcome?: TurnOutcome }
  | {
      readonly kind: "running";
      /** seq of the record that opened this running span: the prompt request, or the first event of an adopted turn. */
      readonly sinceSeq: number;
      /** The prompt request id when the turn was opened through this Session; absent for adopted turns. */
      readonly requestId?: string;
      /** Input identity of the current prompt, when known. */
      readonly inputId?: string;
      /**
       * Stop evidence for this running turn, retained so incremental reducers
       * can match abort responses and survive a checkpoint. A dispose request
       * or an accepted abort makes a later exit aborted; unanswered aborts do not.
       * Cleared at the turn boundary, never inferred from the exit code.
       */
      readonly stop?: {
        readonly pendingAbortIds: readonly string[];
        readonly abortedOnExit: boolean;
      };
      readonly phase: RunningPhase;
      /** Envelope receivedAt (unix epoch ms) of the latest folded record. */
      readonly lastEventAt: number;
    }) & { readonly pendingPrompt?: PendingPrompt };
