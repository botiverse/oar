import { streamJsonCompaction } from "./compaction.js";
/* oxlint-disable import/max-dependencies -- The driver composes protocol, input and process-lifetime mechanisms. */
import type { ControlResult, InputOptions, RequestRecord, Session } from "../../contracts/session.js";
import { createAbortFallback } from "../abort-fallback.js";
import { withInputImages, type LoadedImage } from "../input-images.js";
import { withdrawControl } from "../held-input.js";
import { asRecord, parseJson } from "../json.js";
import type { SessionCredentials } from "../session-credentials.js";
import { appendCleanupFailure, cleanupFailureReason } from "../executable/process-cleanup.js";
import type { LineProcess } from "../executable/index.js";
import type { CancellationObservation } from "../executable/process-cancellation.js";
import { streamJsonUserMessage, streamJsonPrompted } from "./input-lifecycle.js";
import { foldStreamJsonStdout } from "./projection.js";
import { streamJsonAbortRequested, type StreamJsonProjectionState } from "./state.js";
import type { StreamJsonSessionProfile } from "./profile.js";

interface StreamJsonSessionState<S extends StreamJsonProjectionState> {
  child: LineProcess;
  /** The prompt request whose turn is running; null while idle. Spontaneous turns (a drained queue message) run with no request. */
  active: RequestRecord | null;
  /** True while the runtime is executing a turn we did not prompt (queue drain or task notification). */
  spontaneous: boolean;
  projection: S;
  disposed: boolean;
}
/** Shared line protocol driver. A runtime launches its own process and supplies its own readbacks. */
export async function streamJsonSession<S extends StreamJsonProjectionState>(
  child: LineProcess,
  sessionId: string,
  credentials: SessionCredentials,
  profile: StreamJsonSessionProfile<S>,
): Promise<Session> {
  const kernel = credentials.kernel(sessionId);
  const userMessage = profile.userMessage ?? streamJsonUserMessage;
  const state: StreamJsonSessionState<S> = { child, active: null, spontaneous: false, projection: profile.initial, disposed: false };
  // Hold queues until turn end; active-turn writes may steer or become an irreversible native queue.
  const commandLifecycle = profile.projection.commandLifecycle !== false;
  const writtenQueues = new Map<string, RequestRecord>();
  const heldQueue: { request: RequestRecord; input: string; inputId?: string; images: readonly LoadedImage[] }[] = [];
  const nativeBusy = (): boolean => state.active !== null || state.spontaneous;
  const compaction = streamJsonCompaction(kernel, profile, state, drainHeld, () => heldQueue.length > 0);
  const busy = (): boolean => nativeBusy() || compaction?.busy() === true;
  let canCancelQueued = false;
  const abortFallback = createAbortFallback(() => { child.kill(); });
  const pendingInterrupts = new Map<string, () => void>();
  let disposeRequest: RequestRecord | null = null;
  let turnRevision = 0;
  let observingCancellation: { readonly revision: number; readonly result: Promise<CancellationObservation> } | null = null;
  let cancellation: CancellationObservation | null = null;
  const waitForCancellation = async (): Promise<void> => {
    try { await observingCancellation?.result; }
    catch { /* The abort reports its observation failure; later input still proceeds. */ }
  };
  const sentInterrupts = new Set<string>();
  const completeCancellation = (): void => {
    cancellation?.complete(); cancellation = null; sentInterrupts.clear();
  };
  const refuseCancellation = (requestId: string): void => {
    sentInterrupts.delete(requestId);
    if (sentInterrupts.size === 0) { completeCancellation(); }
  };
  function drainHeld(): void {
    if (state.disposed || busy() || observingCancellation !== null) { return; }
    const next = heldQueue.shift();
    if (next === undefined) { return; }
    turnRevision += 1;
    state.active = next.request;
    if (commandLifecycle && next.inputId !== undefined) { writtenQueues.set(next.inputId, next.request); }
    state.projection = streamJsonPrompted(state.projection, next.inputId, false, commandLifecycle);
    if (!commandLifecycle) { state.spontaneous = true; }
    child.write(userMessage(next.input, next.inputId, next.images));
  }
  // The fold translates and attributes facts; this driver owns transport, busy and queue drain.
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) { return; }
    if (message.type === "system" && message.subtype === "init" && typeof message.parent_tool_use_id !== "string" && Array.isArray(message.capabilities)) {
      canCancelQueued = profile.cancelQueuedCapability !== undefined && message.capabilities.includes(profile.cancelQueuedCapability);
    }
    if (profile.consume(message)) { return; }
    const { state: nextProjection, commands } = foldStreamJsonStdout(profile.projection, state.projection, message);
    state.projection = nextProjection;
    if (message.type === "command_lifecycle" && message.state === "queued" && typeof message.command_uuid === "string") {
      const queued = writtenQueues.get(message.command_uuid);
      if (queued !== undefined && state.active === null) { state.active = queued; }
    }
    if (message.type === "command_lifecycle" && (message.state === "completed" || message.state === "cancelled") && typeof message.command_uuid === "string") {
      writtenQueues.delete(message.command_uuid);
    }
    if (message.type === "command_lifecycle" && message.state === "started"
      && state.active !== null && "inputId" in state.active.body && message.command_uuid === state.active.body.inputId) {
      state.spontaneous = false;
    }
    let ended = false;
    let dropped = false;
    for (const command of commands) {
      switch (command.kind) {
        case "frame": {
          // A spontaneous start can arrive at init or at a later queued receipt.
          if (command.agentPath.length === 0 && command.body.events.some((event) => event.kind === "turn_active" && event.inputId === undefined)) {
            if (!busy()) { turnRevision += 1; }
            state.spontaneous = true;
          }
          const nativeResponse = profile.compaction?.responseTo?.(message);
          const correlated = command.agentPath.length === 0 && nativeResponse !== undefined && nativeResponse === compaction?.requestId();
          const closes = command.agentPath.length === 0 && (correlated || command.body.events.some((event) => event.kind === "turn_ended"));
          if (closes) {
            abortFallback.clear(); completeCancellation(); turnRevision += 1;
            if (state.projection.pendingInputId === null) { state.active = null; }
            state.spontaneous = false;
          }
          const record = kernel.frame(correlated ? { ...command.body, responseTo: nativeResponse } : command.body, { agentPath: command.agentPath });
          if (record.agentPath.length > 0) { break; }
          ended ||= closes;
          const cancelled = command.body.events.find((event) => event.kind === "input_dropped");
          dropped ||= cancelled !== undefined;
          if (cancelled?.kind === "input_dropped") { writtenQueues.delete(cancelled.inputId); }
          if (cancelled?.kind === "input_dropped" && state.active !== null && cancelled.inputId === (state.active.body.kind === "compact" ? state.active.id : ("inputId" in state.active.body ? state.active.body.inputId : undefined))) { state.active = null; }
          break;
        }
        case "respond": {
          const refused = pendingInterrupts.get(command.requestId);
          if (refused !== undefined) {
            pendingInterrupts.delete(command.requestId);
            if (command.body.kind === "rejected") {
              refused(); refuseCancellation(command.requestId);
            }
            kernel.respond(command.requestId, command.body);
          } else {
            // Preserve late/duplicate stdout after exit without answering a request twice.
            kernel.frame({ type: "control_response", native: message, events: [] });
          }
          break;
        }
        case "toApp": {
          kernel.request("toApp", { kind: "native", type: command.type, native: command.native }, { id: command.id });
          const request = asRecord(message.request);
          const reply = command.type === "can_use_tool" && request !== null ? profile.permissionResponse?.(command.id, request) : undefined;
          if (reply !== undefined && reply !== null) {
            child.write(`${JSON.stringify(reply)}\n`);
            kernel.respond(command.id, { kind: "accepted", native: reply });
          }
          break;
        }
        default:
          break;
      }
    }
    if (dropped && !ended && !busy()) {
      abortFallback.clear(); completeCancellation(); turnRevision += 1;
      if (state.projection.pendingInputId === null) { state.active = null; }
      state.spontaneous = false;
    }
    if (ended || (dropped && !busy())) { drainHeld(); }
  });
  child.onExit((code, cleanupReason) => {
    abortFallback.clear(); completeCancellation(); turnRevision += 1;
    // An exit before fallback still precedes the rejected pending controls.
    const reasons = [profile.exitReason?.(), cleanupReason].filter((value) => value !== undefined);
    const reason = reasons.length === 0 ? undefined : reasons.join("; ");
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code, ...(reason === undefined ? {} : { reason }) });
    state.active = null;
    state.spontaneous = false;
    for (const requestId of pendingInterrupts.keys()) {
      pendingInterrupts.delete(requestId);
      kernel.respond(requestId, { kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
    }
    profile.exited(code);
  });
  try {
    await profile.open({ current: () => state.projection, replace: (projection) => { state.projection = projection; }, report: (body) => { kernel.frame(body); } });
  } catch (error) { throw appendCleanupFailure(error, cleanupFailureReason(child.diagnostics().cleanup)); }
  let interruptCounter = 0;
  const capabilities = profile.capabilities;
  const session: Session = credentials.seal({
    id: kernel.sessionId,
    capabilities,
    ...(compaction === null ? {} : { compact: compaction.compact }),
    prompt: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      if (observingCancellation !== null) { await waitForCancellation(); }
      const body = { kind: "prompt" as const, input, ...inputOptions };
      return kernel.control(body, (request) => {
        if (busy() || heldQueue.length > 0) { return { kind: "rejected", code: "busy", reason: "busy" }; }
        return withInputImages(capabilities, inputOptions?.images, (images) => {
          turnRevision += 1;
          state.active = request;
          state.projection = streamJsonPrompted(state.projection, inputOptions?.inputId, true, commandLifecycle);
          child.write(userMessage(input, inputOptions?.inputId, images));
          return { kind: "accepted" };
        });
      });
    },
    ...(profile.steer ? {
      steer: async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
        if (observingCancellation !== null) { await waitForCancellation(); }
        return kernel.control({ kind: "steer", input, ...inputOptions }, () => {
          if (compaction?.busy() === true) { return { kind: "rejected", code: "busy", reason: "Manual compaction is still in progress" }; }
          if (!nativeBusy()) { return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }; }
          return withInputImages(capabilities, inputOptions?.images, (images) => {
            child.write(userMessage(input, inputOptions?.inputId, images));
            return { kind: "accepted" };
          });
        });
      },
    } : {}),
    queue: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "queue", input, ...inputOptions }, (request) =>
        withInputImages(capabilities, inputOptions?.images, (images) => {
          if (busy() || heldQueue.length > 0 || observingCancellation !== null) {
            heldQueue.push({ request, input, ...(inputOptions?.inputId === undefined ? {} : { inputId: inputOptions.inputId }), images });
          } else {
            turnRevision += 1;
            if (commandLifecycle && inputOptions?.inputId !== undefined) { writtenQueues.set(inputOptions.inputId, request); }
            state.projection = streamJsonPrompted(state.projection, inputOptions?.inputId, false, commandLifecycle);
            if (!commandLifecycle) { state.spontaneous = true; }
            child.write(userMessage(input, inputOptions?.inputId, images));
          }
          return { kind: "accepted" };
        }));
      return result;
    },
    withdraw: withdrawControl(kernel, heldQueue),
    abort: async (): Promise<ControlResult> => {
      // The matching control_response answers interrupt; the result frame ends the turn.
      interruptCounter += 1;
      const requestId = `interrupt-${interruptCounter}`;
      // Record by hand so the fold can answer this id from control_response; gate reachability here.
      const blocked = kernel.unreachable() ?? (compaction?.busy() === true && !compaction.admitted()
        ? { kind: "rejected", code: "busy", reason: "Claude has not yet dispatched the compact command that abort would cancel" } as const : null);
      const request = kernel.request("toRuntime", { kind: "abort" }, { id: requestId });
      if (blocked !== null || (!nativeBusy() && compaction?.busy() !== true && !(canCancelQueued && state.projection.unstartedInputs.size > 0))) {
        return { request, response: kernel.respond(request.id, blocked ?? { kind: "rejected", code: "no_active_turn", reason: "no active turn" }) };
      }
      const revision = turnRevision;
      observingCancellation ??= { revision, result: cancellation === null ? child.observeCancellation() : Promise.resolve(cancellation) };
      const window = observingCancellation;
      let observation: CancellationObservation | null = null;
      try { observation = await window.result; }
      catch (error) {
        return { request, response: kernel.respond(request.id, { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) }) };
      } finally {
        // Preserve the observed turn until interrupt has been written. A
        // drained arrival must not advance its revision before that check.
        if (observingCancellation === window) { observingCancellation = null; queueMicrotask(drainHeld); }
      }
      const afterObservation = kernel.unreachable();
      if (turnRevision !== revision || window.revision !== revision || afterObservation !== null || state.disposed) {
        observation.complete();
        return { request, response: kernel.respond(request.id, afterObservation ?? { kind: "rejected", code: "no_active_turn", reason: "turn ended before cancellation was sent" }) };
      }
      cancellation = observation;
      state.projection = streamJsonAbortRequested(state.projection);
      const { promise, resolve } = Promise.withResolvers<ControlResult>();
      const unsubscribe = kernel.rawEvents((record) => {
        if (record.kind === "response" && record.requestId === requestId) {
          resolve({ request, response: record });
        }
      });
      // A repeated abort during termination is taken over synchronously too.
      pendingInterrupts.set(requestId, () => {});
      const refuse = abortFallback.arm(() => {
        if (pendingInterrupts.delete(requestId)) {
          kernel.respond(requestId, { kind: "accepted" });
        }
      });
      if (pendingInterrupts.has(requestId)) { pendingInterrupts.set(requestId, refuse); }
      observation.commit(); sentInterrupts.add(requestId);
      child.write(`${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt", ...(canCancelQueued && state.projection.unstartedInputs.size > 0 ? { cancel_queued: true } : {}) },
      })}\n`);
      const result = await promise;
      unsubscribe();
      return result;
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    resources: child.resources,
    ...(profile.contextBreakdown === undefined ? {} : { contextBreakdown: profile.contextBreakdown }),
    dispose: async () => {
      if (state.disposed) { return; }
      state.disposed = true;
      // stdin ends now: no query may write to it any more.
      profile.disposing();
      const gone = kernel.unreachable() !== null; // only an observed exit can say so before this dispose is recorded
      disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
      if (gone) {
        // The exit is already recorded; nothing is left to release.
        kernel.respond(disposeRequest.id, { kind: "accepted" });
        return;
      }
      if (profile.close === undefined) { child.kill(); }
      else { await profile.close(busy()); }
      await child.exited; // release point for anything the process held; the exit response is recorded by onExit
    },
  });
  return session;
}
