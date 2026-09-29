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
  | {
      readonly kind: "idle";
      readonly lastTurnOutcome?: TurnOutcome;
      /** See `running.awaiting`: work the runtime runs outside a turn (a background sub-agent) can ask too. */
      readonly awaiting?: readonly string[];
    }
  | {
      readonly kind: "running";
      /** seq of the record that opened this running span: the prompt request, or the first event of an adopted turn. */
      readonly sinceSeq: number;
      /** The prompt request id when the turn was opened through this Session; absent for adopted turns. */
      readonly requestId?: string;
      readonly phase: RunningPhase;
      /** Envelope receivedAt (unix epoch ms) of the latest folded record. */
      readonly lastEventAt: number;
      /**
       * Ids of the runtime→app requests a person owes an answer (`toApp`
       * requests with an `ask`, in arrival order), while any are open: not yet
       * answered, withdrawn, or voided by the process exit. The runtime is
       * waiting on the host, so the silence is not a stall (`stallOf`).
       * Absent when none is open.
       */
      readonly awaiting?: readonly string[];
    };
