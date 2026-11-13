// BYOK change: Modified from OAR 95c6547 so a failed prompt reads its turn frames only after earlier notifications are recorded, and a native cancel follows a read of the agent's descendants (Apache-2.0).
import type {
  InputImage,
  InputOptions,
  RuntimeEventBody,
  RequestRecord,
  ResponseBody,
  SessionCapabilities,
  TurnOutcome,
} from "../../contracts/session.js";
import { withdrawHeld } from "../held-input.js";
import { withInputImages } from "../input-images.js";
import { inputBytesRefusal } from "../control-input.js";
import { asRecord, type JsonRecord } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";
import { AcpError, acpProcessExitedError } from "./errors.js";
import { type AcpSessionProfile, type UsageUpdateGate } from "./profile.js";
import { acpPrompt, promptAcp } from "./prompt.js";
import { methods, type AcpProcess } from "./process.js";
import {
  acpErrorNative,
  acpFailureOutcome,
  defaultAcpPromptOutcome,
} from "./projection.js";

/**
 * Owns the active turn, replies, queue and cancellation. Native replies end
 * turns; refused steers drop only their input; process exit has its own response.
 */
/**
 * BYOK change: how long a turn waits for a runtime to honor `session/cancel`
 * before the fallback stops it, when the profile names no `abortTimeoutMs`.
 * The cancel write itself gets the same bound: a runtime that has not taken
 * the cancel off its stdin by then would not honor it before the fallback.
 */
const DEFAULT_ABORT_TIMEOUT_MS = 10_000;

export interface ActiveTurn {
  /** The prompt request that opened this turn; null for a spontaneous (queue-drained) turn. */
  readonly request: RequestRecord | null;
  /** The last record before this turn: what the runtime said during it comes after. */
  readonly since: number;
  readonly outcomes: Map<number, TurnOutcome>;
  readonly pending: Set<number>;
  /** Replies received before the SDK notification flush and final record publication. */
  readonly answered: Set<number>;
  abortRequested: boolean;
  /** BYOK change: the answer of the cancel write in flight, shared by an abort that arrives meanwhile. */
  cancelWrite?: Promise<ResponseBody>;
  /** BYOK change: settled when the turn closes, for an abort fenced after the prompt answer was decoded. */
  closed?: PromiseWithResolvers<void>;
  /** BYOK change: a cancel write of this turn did not complete within its bound; this turn writes no second one. */
  stdinUnwritable?: true;
  fallback: NodeJS.Timeout | null;
}

export interface AcpTurns {
  active(): ActiveTurn | null;
  queued(): boolean;
  drain(): void;
  /** Reserve native cancellation ownership for a dedicated control (or a turn the runtime runs on its own, `null`), without fabricating a prompt. */
  beginOperation(request: RequestRecord | null): ActiveTurn;
  finishOperation(state: ActiveTurn): void;
  /** Open a turn with one prompt RPC; rejected when the process is gone or its images can't go (`inputImagesRefusal`). */
  begin(request: RequestRecord | null, input: string, images?: readonly InputImage[]): ResponseBody;
  /** Another prompt RPC inside the active turn (the profile's steer params); rejected like `begin`. */
  steer(state: ActiveTurn, input: string, options: InputOptions | undefined, extraParams: JsonRecord): Promise<ResponseBody>;
  /** session/cancel, then a bounded fallback: release this shared root or stop its isolated process. */
  abort(state: ActiveTurn, request?: RequestRecord): Promise<ResponseBody>;
  /** Hold input for the next turn, drained when the active one closes; rejected like `begin`. */
  hold(input: string, images: readonly InputImage[] | undefined, inputId: string | undefined, request: RequestRecord): Promise<ResponseBody>;
  /** Take a held input back by its `inputId` before the drain sends it (`withdrawHeld`). */
  withdraw(inputId: string): ResponseBody;
  /** The process is gone: close the active turn (its end is the exited response) and drop held input. */
  onExit(): void;
}

const noActiveTurn = (): ResponseBody => ({ kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" });
export function createAcpTurns(deps: {
  readonly kernel: SessionKernel;
  readonly runtime: AcpProcess;
  readonly profile: AcpSessionProfile;
  readonly usageGate: UsageUpdateGate;
  readonly capabilities: Pick<SessionCapabilities, "images">;
  readonly promptMeta?: JsonRecord | undefined;
  readonly promptUsage: (response: JsonRecord) => RuntimeEventBody | null;
  readonly fallback?: (request: RequestRecord) => Promise<void>;
  readonly operationBusy?: () => boolean;
  /** Native turns (`nativeTurns`): params naming a prompt from its input id, and what a closing turn hands on (native-turns.ts). */ readonly native?: { readonly promptParams: (inputId: string | undefined) => JsonRecord; readonly afterClose: () => readonly RuntimeEventBody[] } | undefined;
}): AcpTurns {
  const { kernel, runtime, profile, usageGate, capabilities, promptUsage, promptMeta } = deps;
  const rootId = kernel.sessionId;
  const held: { readonly inputId: string | undefined; readonly input: string; readonly images: readonly InputImage[] | undefined; readonly request: RequestRecord; readonly prompt: JsonRecord[]; accepted: boolean }[] = [];
  let dispatching = false;
  kernel.rawEvents((record) => {
    if (record.kind !== "response" || record.body.kind !== "accepted" || record.body.queued !== "adapter") { return; }
    const entry = held.find(value => value.request.id === record.requestId);
    if (entry !== undefined) { entry.accepted = true; queueMicrotask(drainHeld); }
  });
  let active: ActiveTurn | null = null;
  let nextRequest = 0;

  const closeTurn = (state: ActiveTurn): readonly RuntimeEventBody[] => {
    if (state.fallback !== null) {
      clearTimeout(state.fallback);
      state.fallback = null;
    }
    if (active === state) {
      active = null;
    }
    state.closed?.resolve();
    queueMicrotask(drainHeld); return deps.native?.afterClose() ?? [];
  };
  const finishRequest = (
    state: ActiveTurn,
    requestNumber: number,
    frame: { readonly type: string; readonly native: unknown; readonly context: RuntimeEventBody | null; readonly dropped?: string | undefined; readonly steered: boolean },
    outcome: TurnOutcome | null,
  ): void => {
    state.pending.delete(requestNumber);
    if (outcome !== null) { state.outcomes.set(requestNumber, outcome); }
    const closes = active === state && (profile.steerSupersedesPrompt === true ? state.pending.size === 0 : !frame.steered);
    const events: RuntimeEventBody[] = [];
    if (frame.dropped !== undefined) {
      events.push({ kind: "input_dropped", inputId: frame.dropped, reason: "runtime_refused" });
    }
    if (closes) {
      const terminal = profile.steerSupersedesPrompt === true
        ? state.outcomes.get(Math.max(...state.outcomes.keys()))
        : outcome;
      if (terminal !== null && terminal !== undefined) { events.push({ kind: "turn_ended", outcome: terminal }); }
    }
    if (frame.context !== null) {
      events.push(frame.context);
    }
    if (closes) { events.push(...closeTurn(state)); }
    kernel.frame({ type: frame.type, native: frame.native, events });
  };
  const staleSteer = new Error("not_steerable: no active turn");
  const startVendorPrompt = (state: ActiveTurn, prompt: readonly JsonRecord[], extraParams: JsonRecord = {}, steered?: { readonly inputId: string | undefined; readonly respond: (body: ResponseBody) => void }): void => {
    nextRequest += 1;
    const requestNumber = nextRequest;
    // An unsent steer must not keep its original turn open while awaiting dispatch.
    if (steered === undefined) { state.pending.add(requestNumber); }
    const dispatch = { sent: false };
    void (async (): Promise<void> => {
      try {
        // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the native ACP extension envelope.
        const params = promptMeta === undefined ? extraParams : { ...extraParams, _meta: { ...promptMeta, ...asRecord(extraParams._meta) } };
        const result = await promptAcp(runtime, rootId, prompt, params, {
          beforeSend: () => {
            if (steered !== undefined && (active !== state || state.abortRequested)) { throw staleSteer; }
            state.pending.add(requestNumber);
            usageGate.arm();
          },
          sent: () => { dispatch.sent = true; steered?.respond({ kind: "accepted" }); },
          received: () => { if (dispatch.sent) { state.answered.add(requestNumber); } },
        });
        // Kimi's bounded late-usage wait precedes turn end so contextUsage()
        // at that end includes this turn's usage.
        if (state.cancelWrite !== undefined) { await state.cancelWrite; } // BYOK change: see the failure branch.
        await usageGate.settleAfterPrompt(profile, state.abortRequested);
        const usage = promptUsage(result);
        finishRequest(state, requestNumber, {
          type: methods.agent.session.prompt,
          native: result,
          context: usage,
          steered: steered !== undefined,
        }, profile.promptOutcome?.(result) ?? defaultAcpPromptOutcome(result));
      } catch (error) {
        if (steered !== undefined && !dispatch.sent) {
          state.pending.delete(requestNumber);
          steered.respond(error === staleSteer ? noActiveTurn() : (runtime.closed ? gone()
            : { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) }));
          return; // No native request means no native error frame or turn outcome.
        }
        if (error instanceof AcpError && error.kind === "process_exited") {
          // The exit observer records `exited`, which ends this turn.
          state.pending.delete(requestNumber);
          closeTurn(state);
          return;
        }
        // BYOK change: a failed prompt reads its turn frames only after the
        // notifications received before the failure are recorded. The SDK
        // rejects the prompt as soon as it reads the error, while a
        // notification from the same pipe read is still in its microtask
        // handler chain (grok's retry_state names the failure class). One
        // event-loop turn drains that chain, as promptAcp already yields on
        // success.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        // BYOK change: an abort whose cancel write is still pending decides
        // whether this failure is the abort's; a rejected write clears the mark.
        if (state.cancelWrite !== undefined) { await state.cancelWrite; }
        const turnFrames = kernel.records().flatMap((record) => (record.kind === "frame" && record.seq > state.since ? [record.body] : []));
        const outcome = state.abortRequested ? { kind: "aborted" as const } : acpFailureOutcome(error, turnFrames, profile.failureOutcome);
        const refused = steered !== undefined && (profile.isSteerRefusal?.(error) === true || profile.steerOutcomeIsLatest !== true
          || [...state.pending].some(number => number < requestNumber && !state.answered.has(number)));
        finishRequest(state, requestNumber, {
          type: `${methods.agent.session.prompt}/error`,
          native: acpErrorNative(error),
          context: null,
          steered: steered !== undefined,
          ...(refused ? { dropped: steered.inputId } : {}),
        }, refused ? null : outcome);
      }
    })();
  };
  const gone = (): ResponseBody => ({ kind: "rejected", code: "runtime_exited", reason: acpProcessExitedError(runtime.exitCode).message });
  const open = (request: RequestRecord | null, prompt: readonly JsonRecord[]): ResponseBody => {
    if (runtime.closed) {
      return gone();
    }
    const state = beginOperation(request);
    startVendorPrompt(state, prompt, deps.native?.promptParams(request?.body.kind === "prompt" ? request.body.inputId : undefined));
    return { kind: "accepted" };
  };
  const beginOperation = (request: RequestRecord | null): ActiveTurn => {
    const state: ActiveTurn = {
      request,
      since: kernel.records().at(-1)?.seq ?? -1,
      outcomes: new Map(),
      pending: new Set(),
      answered: new Set(),
      abortRequested: false,
      fallback: null,
    };
    active = state;
    return state;
  };
  const begin = (request: RequestRecord | null, input: string, images?: readonly InputImage[]): ResponseBody =>
    inputBytesRefusal(profile.maxInputBytes, input) ?? withInputImages(capabilities, images, (loaded) => open(request, acpPrompt(input, loaded)));
  function drainHeld(): void {
    // Held input is dropped once the stream says the runtime is unreachable
    // (an `exited` response or a `dispose` request), not by an adapter flag.
    if (kernel.unreachable() !== null || active !== null || runtime.closed || deps.operationBusy?.() === true) {
      return;
    }
    // Taken off `held` in the same step it is sent: a withdraw after this finds it gone.
    if (held[0]?.accepted !== true) { return; }
    const next = held.shift();
    if (next !== undefined) {
      dispatching = true;
      try {
        const request = kernel.request("toRuntime", { kind: "prompt", input: next.input,
          carries: [next.inputId ?? next.request.id], ...(next.images === undefined ? {} : { images: next.images }) });
        kernel.respond(request.id, open(request, next.prompt));
      } finally { dispatching = false; }
    }
  }

  return {
    active: () => active,
    queued: () => dispatching || held.length > 0,
    drain: drainHeld,
    beginOperation,
    finishOperation: (state) => { closeTurn(state); },
    begin,
    async steer(state, input, options, extraParams) {
      await runtime.spawned;
      if (runtime.closed) {
        return gone();
      }
      if (active !== state || state.abortRequested) {
        return noActiveTurn();
      }
      // oxlint-disable-next-line typescript/promise-function-async -- Return the dispatch receipt promise without another async wrapper.
      return inputBytesRefusal(profile.maxInputBytes, input) ?? withInputImages(capabilities, options?.images, (loaded) => {
        const admission = Promise.withResolvers<ResponseBody>();
        startVendorPrompt(state, acpPrompt(input, loaded), extraParams, { inputId: options?.inputId, respond: admission.resolve });
        return admission.promise;
      });
    },
    async abort(state, request) {
      if (state.cancelWrite !== undefined) { return state.cancelWrite; }
      // BYOK change: once every prompt of the turn has its answer decoded, the
      // runtime has ended it, and a session-wide cancel would reach whatever it
      // runs next. Send none; answer when the turn's closing frame is out.
      if (!state.abortRequested && state.pending.size > 0 && [...state.pending].every((number) => state.answered.has(number))) {
        if (active === state) {
          state.closed ??= Promise.withResolvers<void>();
          await state.closed.promise;
        }
        return { kind: "rejected", code: "no_active_turn", reason: "turn ended before cancellation was sent" };
      }
      if (!state.abortRequested) {
        if (state.stdinUnwritable === true) {
          return { kind: "rejected", code: "error", reason: "an earlier session/cancel write of this turn did not complete; no second one is written" };
        }
        // BYOK change: no upstream observation window. The injected process
        // remembers the agent's descendants synchronously before the native
        // cancel can orphan them; the SDK process-tree authority kills those
        // still alive at dispose. No cancel goes out unless the read succeeded.
        try {
          runtime.observeDescendants();
        } catch (error) {
          return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
        }
        state.abortRequested = true;
        // BYOK change: a failed cancel write leaves the turn as it was, so a
        // retry sends the cancel again and a later prompt error stays a failure.
        // A write that does not complete within the bound counts as failed, and
        // the turn's stdin as not writable: the prompt's own end decides the turn.
        const abortTimeoutMs = profile.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
        const write = (async (): Promise<ResponseBody> => {
          let timer: NodeJS.Timeout | undefined;
          const bound = new Promise<{ readonly timedOut: true }>((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), abortTimeoutMs);
            timer.unref();
          });
          const sent = runtime.connection.agent.notify(methods.agent.session.cancel, { sessionId: rootId })
            .then(() => null, (error: unknown) => ({ error }));
          const result = await Promise.race([sent, bound]);
          clearTimeout(timer);
          if (result !== null) {
            state.abortRequested = false;
            if ("timedOut" in result) {
              state.stdinUnwritable = true;
              return { kind: "rejected", code: "error", reason: `session/cancel write did not complete within ${abortTimeoutMs} ms` };
            }
            return { kind: "rejected", code: "error", reason: result.error instanceof Error ? result.error.message : String(result.error) };
          }
          // A stalled shared prompt releases only this root; isolated fallback
          // stops its own process and records the observed exit.
          state.fallback = setTimeout(() => {
            if (active === state) {
              if (deps.fallback !== undefined && request !== undefined) {
                closeTurn(state); held.splice(0);
                void deps.fallback(request);
              } else { runtime.kill(); }
            }
          }, abortTimeoutMs);
          state.fallback.unref();
          return { kind: "accepted" };
        })();
        state.cancelWrite = write;
        const answer = await write;
        if (state.cancelWrite === write) { state.cancelWrite = undefined; }
        return answer;
      }
      return { kind: "accepted" };
    },
    async hold(input, images, inputId, request) {
      await runtime.spawned;
      if (runtime.closed) {
        return gone();
      }
      return inputBytesRefusal(profile.maxInputBytes, input) ?? withInputImages(capabilities, images, (loaded) => {
        held.push({ inputId, input, images, request, prompt: acpPrompt(input, loaded), accepted: false });
        return { kind: "accepted", queued: "adapter" };
      });
    },
    withdraw: (inputId) => withdrawHeld(held, inputId),
    onExit() {
      if (active !== null) {
        closeTurn(active);
      }
      held.splice(0);
    },
  };
}
