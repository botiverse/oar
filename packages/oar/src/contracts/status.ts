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
  | { readonly tool: string; readonly callId: string };

export type AgentStatus =
  | { readonly kind: "idle"; readonly lastTurnOutcome?: TurnOutcome }
  | {
      readonly kind: "running";
      /** seq of the record that opened this running span: the prompt request, or the first event of an adopted turn. */
      readonly sinceSeq: number;
      /** The prompt request id when the turn was opened through this Session; absent for adopted turns. */
      readonly requestId?: string;
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
    };
