import type {
  EventView,
  RequestRecord,
  ResponseBody,
  TurnOutcome,
} from "../../contracts/session.js";
import type { JsonRecord } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";
import { AcpError, acpProcessExitedError } from "./errors.js";
import { promptAcp, type AcpSessionProfile } from "./profile.js";
import { methods, type AcpProcess } from "./process.js";
import {
  acpErrorNative,
  acpFailureOutcome,
  defaultAcpPromptOutcome,
} from "./projection.js";
import type { UsageUpdateGate } from "./usage-wait.js";

/**
 * The turn machinery: ≤1 active turn, each `session/prompt` RPC of it, the
 * host-held queue, cancel with a kill fallback. The RPC ANSWER is the
 * runtime's own turn end and is recorded as an event with a turn_ended view;
 * a rejected RPC is likewise the runtime's word (a prompt-error event). The
 * process dying is not — that is the `exited` response the session records
 * from its exit observer. One turn may span several prompt RPCs (grok's
 * send-now steer): each answer is its own event; the turn_ended view rides
 * the answer that closes the turn, carrying the LATEST request's outcome.
 */
export interface ActiveTurn {
  /** The prompt request that opened this turn; null for a spontaneous (queue-drained) turn. */
  readonly request: RequestRecord | null;
  readonly outcomes: Map<number, TurnOutcome>;
  readonly pending: Set<number>;
  abortRequested: boolean;
  latestRequest: number;
  fallback: NodeJS.Timeout | null;
}

export interface AcpTurns {
  active(): ActiveTurn | null;
  /** Open a turn with one prompt RPC; rejected when the process is gone. */
  begin(request: RequestRecord | null, input: string): ResponseBody;
  /** Another prompt RPC inside the active turn (the profile's steer params); rejected when the process is gone. */
  steer(state: ActiveTurn, input: string, extraParams: JsonRecord): Promise<ResponseBody>;
  /** session/cancel, then a bounded wait after which the process is killed. */
  abort(state: ActiveTurn): Promise<ResponseBody>;
  /** Hold input for the next turn, drained when the active one closes; rejected when the process is gone. */
  hold(input: string): Promise<ResponseBody>;
  /** The process is gone: close the active turn (its end is the exited response) and drop held input. */
  onExit(): void;
}

export function createAcpTurns(deps: {
  readonly kernel: SessionKernel;
  readonly runtime: AcpProcess;
  readonly profile: AcpSessionProfile;
  readonly usageGate: UsageUpdateGate;
  readonly disposed: () => boolean;
}): AcpTurns {
  const { kernel, runtime, profile, usageGate } = deps;
  const rootId = kernel.sessionId;
  const held: string[] = [];
  let active: ActiveTurn | null = null;
  let nextRequest = 0;

  const closeTurn = (state: ActiveTurn): void => {
    if (state.fallback !== null) {
      clearTimeout(state.fallback);
      state.fallback = null;
    }
    if (active === state) {
      active = null;
    }
    queueMicrotask(drainHeld);
  };
  const finishRequest = (
    state: ActiveTurn,
    requestNumber: number,
    frame: { readonly type: string; readonly native: unknown; readonly context: EventView | null },
    outcome: TurnOutcome,
  ): void => {
    state.pending.delete(requestNumber);
    state.outcomes.set(requestNumber, outcome);
    const closes = state.pending.size === 0;
    const views: EventView[] = [];
    if (closes) {
      views.push({ kind: "turn_ended", outcome: state.outcomes.get(state.latestRequest) ?? outcome });
    }
    if (frame.context !== null) {
      views.push(frame.context);
    }
    kernel.event({ type: frame.type, native: frame.native, views });
    if (closes) {
      closeTurn(state);
    }
  };
  const startVendorPrompt = (state: ActiveTurn, input: string, extraParams: JsonRecord = {}): void => {
    nextRequest += 1;
    const requestNumber = nextRequest;
    state.latestRequest = requestNumber;
    state.pending.add(requestNumber);
    void (async (): Promise<void> => {
      try {
        usageGate.arm();
        const result = await promptAcp(runtime, rootId, input, extraParams);
        // Deliberate ordering: the answer's event waits (bounded) for the
        // usage_update kimi pushes AFTER answering, so the usage record
        // precedes the turn end and contextUsage() at turn_ended is this
        // turn's own value.
        await usageGate.settleAfterPrompt(profile, state.abortRequested);
        const context = profile.promptContextUsage?.(result) ?? null;
        finishRequest(state, requestNumber, {
          type: methods.agent.session.prompt,
          native: result,
          context: context === null ? null : { kind: "usage", usage: { context } },
        }, profile.promptOutcome?.(result) ?? defaultAcpPromptOutcome(result));
      } catch (error) {
        if (error instanceof AcpError && error.kind === "process_exited") {
          // Not the runtime's word: the exit observer records the `exited`
          // response, which is the turn's end.
          state.pending.delete(requestNumber);
          closeTurn(state);
          return;
        }
        const outcome = state.abortRequested ? { kind: "aborted" as const } : acpFailureOutcome(error);
        finishRequest(state, requestNumber, {
          type: `${methods.agent.session.prompt}/error`,
          native: acpErrorNative(error),
          context: null,
        }, outcome);
      }
    })();
  };
  const gone = (): ResponseBody => ({ kind: "rejected", reason: acpProcessExitedError(runtime.exitCode).message });
  const begin = (request: RequestRecord | null, input: string): ResponseBody => {
    if (runtime.closed) {
      return gone();
    }
    const state: ActiveTurn = {
      request,
      outcomes: new Map(),
      pending: new Set(),
      abortRequested: false,
      latestRequest: 0,
      fallback: null,
    };
    active = state;
    startVendorPrompt(state, input);
    return { kind: "accepted" };
  };
  function drainHeld(): void {
    if (deps.disposed() || active !== null || runtime.closed) {
      return;
    }
    const input = held.shift();
    if (input !== undefined) {
      begin(null, input);
    }
  }

  return {
    active: () => active,
    begin,
    async steer(state, input, extraParams) {
      await runtime.spawned;
      if (runtime.closed) {
        return gone();
      }
      startVendorPrompt(state, input, extraParams);
      return { kind: "accepted" };
    },
    async abort(state) {
      if (!state.abortRequested) {
        state.abortRequested = true;
        try {
          await runtime.connection.agent.notify(methods.agent.session.cancel, { sessionId: rootId });
        } catch (error) {
          return { kind: "rejected", reason: error instanceof Error ? error.message : String(error) };
        }
        // A runtime that never answers the cancelled prompt is killed; the
        // exit then shows up as the `exited` response, the turn's end.
        state.fallback = setTimeout(() => {
          if (active === state) {
            runtime.kill();
          }
        }, profile.abortTimeoutMs ?? 10_000);
        state.fallback.unref();
      }
      return { kind: "accepted" };
    },
    async hold(input) {
      await runtime.spawned;
      if (runtime.closed) {
        return gone();
      }
      held.push(input);
      queueMicrotask(drainHeld);
      return { kind: "accepted" };
    },
    onExit() {
      if (active !== null) {
        closeTurn(active);
      }
      held.splice(0);
    },
  };
}
