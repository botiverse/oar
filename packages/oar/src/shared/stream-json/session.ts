import { appendStartupStderr, sessionExitReason } from "../executable/reported-stderr.js";
import { streamJsonAppRequest } from "./permission.js";
import { createUserQuestions, userQuestionAnswering } from "../user-questions.js";
import { streamJsonResultReadback } from "./result-readback.js";
import { writeHeldInput, type HeldStreamJsonInput } from "./held-input.js";
import { streamJsonTaskControl } from "./task-control.js";
import { streamJsonCompaction } from "./compaction.js";
/* oxlint-disable import/max-dependencies -- The driver composes protocol, input and process-lifetime mechanisms. */
import type { ControlResult, InputOptions, RequestRecord, Session } from "../../contracts/session.js";
import { createAbortFallback } from "../abort-fallback.js";
import { withInputImages } from "../input-images.js";
import { enqueueHeld, withdrawControl } from "../held-input.js";
import type { JsonRecord } from "../json.js";
import type { SessionCredentials } from "../session-credentials.js";
import { appendCleanupFailure, cleanupFailureReason } from "../executable/process-cleanup.js";
import type { LineProcess } from "../executable/index.js";
import type { CancellationObservation } from "../executable/process-cancellation.js";
import { streamJsonUserMessage, streamJsonPrompted } from "./input-lifecycle.js";
import { foldStreamJsonStdout } from "./projection.js";
import { streamJsonAbortRequested, type StreamJsonProjectionState, type StreamJsonSessionState } from "./state.js";
import type { StreamJsonSessionProfile } from "./profile.js";

/** Shared line protocol driver. A runtime launches its own process and supplies its own readbacks. */
export async function streamJsonSession<S extends StreamJsonProjectionState>(
  child: LineProcess,
  sessionId: string,
  credentials: SessionCredentials,
  profile: StreamJsonSessionProfile<S>,
): Promise<Session> {
  const kernel = profile.kernel ?? credentials.kernel(sessionId);
  const tasks = profile.stopTask === undefined ? undefined : streamJsonTaskControl(kernel, child, profile.stopTask);
  const questions = profile.questionReply === undefined ? undefined : createUserQuestions(kernel);
  const answerQuestion: Session["answerQuestion"] = profile.answerQuestion ?? (questions === undefined ? undefined : userQuestionAnswering(questions));
  const userMessage = profile.userMessage ?? streamJsonUserMessage;
  const state: StreamJsonSessionState<S> = { child, active: null, projection: profile.initial };
  // Hold queues until turn end; active-turn writes may steer or become an irreversible native queue.
  const commandLifecycle = profile.projection.commandLifecycle !== false;
  const writtenQueues = new Map<string, RequestRecord>();
  const heldQueue: HeldStreamJsonInput[] = [];
  let dispatching = false;
  const nativeBusy = (): boolean => !messages.settling() && (state.active !== null || state.projection.nativeTurnActive);
  const compaction = streamJsonCompaction(kernel, profile, state, drainHeld, () => heldQueue.length > 0);
  const busy = (): boolean => dispatching || messages.settling() || nativeBusy() || compaction?.busy() === true;
  let canCancelQueued = false;
  const abortFallback = createAbortFallback(() => { child.kill(); });
  const pendingInterrupts = new Map<string, () => void>();
  let turnRevision = 0;
  let observingCancellation: { readonly revision: number; readonly result: Promise<CancellationObservation> } | null = null;
  let cancellation: CancellationObservation | null = null;
  const waitForCancellation = async (): Promise<void> => {
    try { await observingCancellation?.result; } catch { /* The abort reports observation failure; later input still proceeds. */ }
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
    if (messages.hasExited() || kernel.unreachable() !== null || busy() || observingCancellation !== null || heldQueue[0]?.accepted !== true) { return; }
    const next = heldQueue.shift();
    if (next === undefined) { return; }
    dispatching = true;
    const { inputId: _inputId, ...options } = next.options;
    const request = kernel.request("toRuntime", { kind: "prompt", input: next.input, ...options, carries: [next.inputId ?? next.request.id] });
    const response = writeHeldInput(state, next, { kernel, commandLifecycle, writtenQueues, held: heldQueue, userMessage, advance: () => { turnRevision += 1; dispatching = false; } });
    dispatching = false;
    kernel.respond(request.id, response);
    if (response.kind === "accepted") { drainHeld(); }
  }
  const processMessage = (message: JsonRecord, receivedAt: number): void => {
    const wasBusy = busy();
    const { state: nextProjection, commands } = foldStreamJsonStdout(profile.projection, state.projection, message);
    state.projection = nextProjection;
    if (message.type === "command_lifecycle" && message.state === "queued" && typeof message.command_uuid === "string") {
      const queued = writtenQueues.get(message.command_uuid);
      if (queued !== undefined && state.active === null) { state.active = queued; }
    }
    if (message.type === "command_lifecycle" && (message.state === "completed" || message.state === "cancelled") && typeof message.command_uuid === "string") {
      writtenQueues.delete(message.command_uuid);
    }
    let ended = false;
    let dropped = false;
    for (const command of commands) {
      switch (command.kind) {
        case "frame": {
          // A spontaneous start can arrive at init or at a later queued receipt.
          if (!wasBusy && command.agentPath.length === 0 && command.body.events.some((event) => event.kind === "turn_active" && event.inputId === undefined)) {
            turnRevision += 1;
          }
          const nativeResponse = profile.compaction?.responseTo?.(message);
          const correlated = command.agentPath.length === 0 && nativeResponse !== undefined && nativeResponse === compaction?.requestId();
          const closes = command.agentPath.length === 0 && (correlated || command.body.events.some((event) => event.kind === "turn_ended"));
          if (closes) {
            abortFallback.clear(); completeCancellation(); turnRevision += 1;
            if (state.projection.pendingInputId === null) { state.active = null; }
            if (correlated && state.projection.nativeTurnActive) {
              state.projection = { ...state.projection, nativeTurnActive: false, turnActive: false };
            }
          }
          const cancelled = command.body.events.find((event) => event.kind === "input_dropped");
          if (command.agentPath.length === 0 && cancelled?.kind === "input_dropped" && cancelled.inputId !== undefined) {
            writtenQueues.delete(cancelled.inputId);
            if (state.active !== null && cancelled.inputId === (state.active.body.kind === "compact" ? state.active.id : ("inputId" in state.active.body ? state.active.body.inputId : undefined))) { state.active = null; }
          }
          for (const event of command.body.events) { if (event.kind === "app_request_cancelled") { questions?.withdraw(event.requestId); } }
          const record = kernel.frame(correlated ? { ...command.body, responseTo: nativeResponse } : command.body, { agentPath: command.agentPath, receivedAt });
          if (record.agentPath.length > 0) { break; }
          ended ||= closes;
          dropped ||= cancelled !== undefined;
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
        case "toApp":
          if (profile.appRequest?.(command.id, command.type, message) !== true) {
            streamJsonAppRequest(kernel, child, command.id, command.type, message, profile, questions);
          }
          break;
        default:
          break;
      }
    }
    if (dropped && !ended && !busy()) {
      abortFallback.clear(); completeCancellation(); turnRevision += 1;
      if (state.projection.pendingInputId === null) { state.active = null; }
    }
    if (ended || (dropped && !busy())) { drainHeld(); }
  };
  const messages = streamJsonResultReadback(child, {
    before: (): Promise<void> | void => {
      if (profile.beforeRootResult === undefined || kernel.unreachable() !== null) { return; }
      // Native work has ended; hold input without interrupting a completed turn during readback.
      abortFallback.clear(); completeCancellation(); turnRevision += 1;
      return profile.beforeRootResult(kernel, state.projection);
    },
    process: processMessage,
    consume: (message) => {
      if (message.type === "system" && message.subtype === "init" && typeof message.parent_tool_use_id !== "string" && Array.isArray(message.capabilities)) {
        canCancelQueued = profile.cancelQueuedCapability !== undefined && message.capabilities.includes(profile.cancelQueuedCapability);
      }
      return tasks?.consume(message) === true || profile.consume(message);
    },
    exiting: profile.exited,
    exited: (code, reason) => { finishExit(code, reason); },
  });
  const finishExit = (code: number | null, cleanupReason?: string): void => {
    abortFallback.clear(); completeCancellation(); turnRevision += 1;
    // An exit before fallback still precedes the rejected pending controls.
    const reasons = [profile.exitReason?.(), sessionExitReason(child, cleanupReason, credentials.redact)].filter(value => value !== undefined);
    const reason = reasons.length === 0 ? undefined : reasons.join("; ");
    // This Session owns one child. Its projection, including open compactions, ends here.
    kernel.processExited(code, reason);
    state.active = null;
    state.projection = { ...state.projection, nativeTurnActive: false, turnActive: false };
    for (const requestId of pendingInterrupts.keys()) {
      pendingInterrupts.delete(requestId);
      kernel.respond(requestId, { kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
    }
    tasks?.end();
  };
  messages.listen();
  try {
    await profile.open({ current: () => state.projection, replace: (projection) => { state.projection = projection; }, report: (body) => { kernel.frame(body); } });
  } catch (error) {
    const diagnostics = child.diagnostics();
    const failure = messages.hasExited() ? appendStartupStderr(error, diagnostics, credentials.redact) : error;
    throw appendCleanupFailure(failure, cleanupFailureReason(diagnostics.cleanup));
  }
  let interruptCounter = 0;
  const capabilities = profile.capabilities;
  return credentials.seal({
    id: kernel.sessionId,
    capabilities,
    ...(compaction === null ? {} : { compact: compaction.compact }),
    ...(tasks === undefined ? {} : { stopTask: tasks.stop }),
    ...(answerQuestion === undefined ? {} : { answerQuestion }),
    prompt: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      if (observingCancellation !== null) { await waitForCancellation(); }
      const body = { kind: "prompt" as const, input, ...inputOptions };
      return kernel.control(body, (request) => {
        if (messages.hasExited()) { return { kind: "rejected", code: "runtime_exited" as const, reason: "runtime exited" }; }
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
          if (messages.hasExited()) { return { kind: "rejected", code: "runtime_exited" as const, reason: "runtime exited" }; }
          enqueueHeld(heldQueue, { request, input, ...(inputOptions?.inputId === undefined ? {} : { inputId: inputOptions.inputId }), options: { ...inputOptions }, images });
          return { kind: "accepted", queued: "adapter" };
        }));
      const entry = heldQueue.find(next => next.request.id === result.request.id);
      if (entry !== undefined && result.response.body.kind === "accepted") { entry.accepted = true; }
      drainHeld();
      return result;
    },
    withdraw: async inputId => { const result = await withdrawControl(kernel, heldQueue)(inputId); drainHeld(); return result; },
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
      if (turnRevision !== revision || window.revision !== revision || afterObservation !== null) {
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
      const interrupt = { subtype: "interrupt", ...(canCancelQueued && state.projection.unstartedInputs.size > 0 ? { cancel_queued: true } : {}) };
      child.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: interrupt })}\n`);
      const result = await promise;
      unsubscribe();
      return result;
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    resources: child.resources,
    ...(profile.lastModelRequest === undefined ? {} : { lastModelRequest: profile.lastModelRequest }),
    ...(profile.contextBreakdown === undefined ? {} : { contextBreakdown: profile.contextBreakdown }),
    dispose: async () => {
      await kernel.dispose(async () => {
        profile.disposing();
        tasks?.end();
        if (profile.close === undefined) { child.kill(); }
        else { await profile.close(busy()); }
        await child.exited; // release point for anything the process held; the exit response is recorded by onExit
      }, () => { profile.disposing(); });
    },
  });
}
