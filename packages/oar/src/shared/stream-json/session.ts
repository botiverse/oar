// BYOK change: Modified from OAR 95c6547 for a caller-owned process, a record consumer, caller-answered app requests and session credential redaction without sealSession (Apache-2.0).
import { streamJsonTaskControl } from "./task-control.js";
import { streamJsonCompaction } from "./compaction.js";
/* oxlint-disable import/max-dependencies -- The driver composes protocol, input and process-lifetime mechanisms. */
import type { AdapterSession, ControlResult, InputOptions, RawEvent, RequestRecord } from "../../contracts/session.js";
import { createAbortFallback } from "../abort-fallback.js";
import { withInputImages, type LoadedImage } from "../input-images.js";
import { withdrawControl } from "../held-input.js";
import { asRecord, parseJson, type JsonRecord } from "../json.js";
// BYOK change: the injected line process, one credential redactor per open and the upstream kernel; no SessionCredentials or executable manager.
import type { LineProcess } from "../../runtimes/codex/app-server-client.js";
import type { CredentialRedactor } from "../credential-redactor.js";
import { createSessionKernel } from "../session-kernel.js";
import { streamJsonUserMessage, streamJsonPrompted } from "./input-lifecycle.js";
import { foldStreamJsonStdout } from "./projection.js";
import { streamJsonAbortRequested, type StreamJsonProjectionState, type StreamJsonSessionState } from "./state.js";
import type { StreamJsonSessionProfile } from "./profile.js";

/** BYOK change: caller hooks. The record consumer sees every record; the caller alone answers a runtime request. */
export interface StreamJsonSessionHooks {
  readonly onRecord?: (record: RawEvent) => void;
  /** Every `toApp` request, whatever its type. `respond` writes the native reply and records it; a request never answered stays unanswered. */
  readonly onAppRequest?: (request: { readonly id: string; readonly type: string; readonly native: JsonRecord }, respond: (reply: JsonRecord) => Promise<void>) => void;
  /** Runs before the native interrupt is written; a throw rejects the abort with code `error` and writes no interrupt. */
  readonly beforeInterrupt?: () => void;
}

/** Shared line protocol driver. A runtime launches its own process and supplies its own readbacks. */
export async function streamJsonSession<S extends StreamJsonProjectionState>(
  child: LineProcess,
  sessionId: string,
  credentials: CredentialRedactor, // BYOK change: the caller builds it with sessionCredentialRedactor.
  profile: StreamJsonSessionProfile<S>,
  hooks: StreamJsonSessionHooks = {},
  retainedBytes?: number, // BYOK change: the caller's retained-record budget; old frame payloads are elided past it.
): Promise<AdapterSession> {
  // BYOK change: the upstream kernel with the redactor as its redact hook; the record consumer is registered before any record is appended.
  const kernel = createSessionKernel(sessionId, credentials.redactValue, retainedBytes);
  if (hooks.onRecord !== undefined) { kernel.rawEvents(hooks.onRecord); }
  const tasks = profile.stopTask === undefined ? undefined : streamJsonTaskControl(kernel, child, profile.stopTask);
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
  // BYOK change: no upstream cancellation observation window; the caller's beforeInterrupt runs synchronously before the interrupt.
  function drainHeld(): void {
    if (state.disposed || busy()) { return; }
    const next = heldQueue.shift();
    if (next === undefined) { return; }
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
    if (tasks?.consume(message) === true || profile.consume(message)) { return; }
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
            state.spontaneous = true;
          }
          const nativeResponse = profile.compaction?.responseTo?.(message);
          const correlated = command.agentPath.length === 0 && nativeResponse !== undefined && nativeResponse === compaction?.requestId();
          const closes = command.agentPath.length === 0 && (correlated || command.body.events.some((event) => event.kind === "turn_ended"));
          if (closes) {
            abortFallback.clear();
            if (state.projection.pendingInputId === null) { state.active = null; }
            state.spontaneous = false;
          }
          const record = kernel.frame(correlated ? { ...command.body, responseTo: nativeResponse } : command.body, { agentPath: command.agentPath });
          if (record.agentPath.length > 0) { break; }
          ended ||= closes;
          const cancelled = command.body.events.find((event) => event.kind === "input_dropped");
          dropped ||= cancelled !== undefined;
          if (cancelled?.kind === "input_dropped" && cancelled.inputId !== undefined) { writtenQueues.delete(cancelled.inputId); }
          if (cancelled?.kind === "input_dropped" && cancelled.inputId !== undefined && state.active !== null && cancelled.inputId === (state.active.body.kind === "compact" ? state.active.id : ("inputId" in state.active.body ? state.active.body.inputId : undefined))) { state.active = null; }
          break;
        }
        case "respond": {
          const refused = pendingInterrupts.get(command.requestId);
          if (refused !== undefined) {
            pendingInterrupts.delete(command.requestId);
            if (command.body.kind === "rejected") { refused(); }
            kernel.respond(command.requestId, command.body);
          } else {
            // Preserve late/duplicate stdout after exit without answering a request twice.
            kernel.frame({ type: "control_response", native: message, events: [] });
          }
          break;
        }
        case "toApp": {
          kernel.request("toApp", { kind: "native", type: command.type, native: command.native }, { id: command.id });
          // BYOK change: every runtime request goes to the caller, whatever its type; profile.permissionResponse is not read.
          // Without a hook, or when the hook does not answer, the request stays unanswered: nothing here allows by default.
          hooks.onAppRequest?.({ id: command.id, type: command.type, native: message }, async (reply) => {
            await child.writeAcknowledged(`${JSON.stringify(reply)}\n`);
            kernel.respond(command.id, { kind: "accepted", native: reply });
          });
          break;
        }
        default:
          break;
      }
    }
    if (dropped && !ended && !busy()) {
      abortFallback.clear();
      if (state.projection.pendingInputId === null) { state.active = null; }
      state.spontaneous = false;
    }
    if (ended || (dropped && !busy())) { drainHeld(); }
  });
  // BYOK change: the injected line process reports no cleanup reason; only the profile's exit reason is recorded.
  child.onExit((code) => {
    abortFallback.clear();
    // An exit before fallback still precedes the rejected pending controls.
    const reason = profile.exitReason?.();
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code, ...(reason === undefined ? {} : { reason }) });
    state.active = null;
    state.spontaneous = false;
    for (const requestId of pendingInterrupts.keys()) {
      pendingInterrupts.delete(requestId);
      kernel.respond(requestId, { kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
    }
    tasks?.end();
    profile.exited(code);
  });
  // BYOK change: an open failure is redacted; the caller owns the process and releases it.
  try {
    await profile.open({ current: () => state.projection, replace: (projection) => { state.projection = projection; }, report: (body) => { kernel.frame(body); } });
  } catch (error) { throw credentials.redactValue(error); }
  let interruptCounter = 0;
  const capabilities = profile.capabilities;
  // BYOK change: the upstream credentials.seal guard without sealSession: a control's thrown error is redacted.
  const guard = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>, cleanResult = false) =>
    async (...args: Args): Promise<Result> => {
      try { const result = await method(...args); return cleanResult ? credentials.redactValue(result) : result; } catch (error) { throw credentials.redactValue(error); }
    };
  const session: AdapterSession = { // BYOK change: raw adapter session without sealSession.
    id: kernel.sessionId,
    capabilities,
    ...(compaction === null ? {} : { compact: guard(compaction.compact, true) }),
    ...(tasks === undefined ? {} : { stopTask: guard(tasks.stop) }),
    prompt: guard(async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
      const body = { kind: "prompt" as const, input, ...inputOptions };
      return kernel.control(body, (request) => {
        if (busy() || heldQueue.length > 0) { return { kind: "rejected", code: "busy", reason: "busy" }; }
        return withInputImages(capabilities, inputOptions?.images, (images) => {
          state.active = request;
          state.projection = streamJsonPrompted(state.projection, inputOptions?.inputId, true, commandLifecycle);
          child.write(userMessage(input, inputOptions?.inputId, images));
          return { kind: "accepted" };
        });
      });
    }),
    ...(profile.steer ? {
      steer: guard(async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
        return kernel.control({ kind: "steer", input, ...inputOptions }, () => {
          if (compaction?.busy() === true) { return { kind: "rejected", code: "busy", reason: "Manual compaction is still in progress" }; }
          if (!nativeBusy()) { return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }; }
          return withInputImages(capabilities, inputOptions?.images, (images) => {
            child.write(userMessage(input, inputOptions?.inputId, images));
            return { kind: "accepted" };
          });
        });
      }),
    } : {}),
    queue: guard(async (input: string, inputOptions?: InputOptions): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "queue", input, ...inputOptions }, (request) =>
        withInputImages(capabilities, inputOptions?.images, (images) => {
          if (busy() || heldQueue.length > 0) {
            heldQueue.push({ request, input, ...(inputOptions?.inputId === undefined ? {} : { inputId: inputOptions.inputId }), images });
          } else {
            if (commandLifecycle && inputOptions?.inputId !== undefined) { writtenQueues.set(inputOptions.inputId, request); }
            state.projection = streamJsonPrompted(state.projection, inputOptions?.inputId, false, commandLifecycle);
            if (!commandLifecycle) { state.spontaneous = true; }
            child.write(userMessage(input, inputOptions?.inputId, images));
          }
          return { kind: "accepted" };
        }));
      return result;
    }),
    withdraw: guard(withdrawControl(kernel, heldQueue)),
    abort: guard(async (): Promise<ControlResult> => {
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
      // BYOK change: the caller's synchronous hook replaces the upstream cancellation observation; no interrupt goes out unless it returns.
      try { hooks.beforeInterrupt?.(); }
      catch (error) {
        return { request, response: kernel.respond(request.id, { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) }) };
      }
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
      child.write(`${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt", ...(canCancelQueued && state.projection.unstartedInputs.size > 0 ? { cancel_queued: true } : {}) },
      })}\n`);
      const result = await promise;
      unsubscribe();
      return result;
    }),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    // BYOK change: the injected line process has no resources reader.
    ...(profile.contextBreakdown === undefined ? {} : { contextBreakdown: profile.contextBreakdown }),
    dispose: guard(async () => {
      if (state.disposed) { return; }
      state.disposed = true;
      // stdin ends now: no query may write to it any more.
      profile.disposing();
      const gone = kernel.unreachable() !== null; // only an observed exit can say so before this dispose is recorded
      disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
      tasks?.end();
      if (gone) {
        // The exit is already recorded; nothing is left to release.
        kernel.respond(disposeRequest.id, { kind: "accepted" });
        return;
      }
      if (profile.close === undefined) { child.kill(); }
      else { await profile.close(busy()); }
      await child.exited; // release point for anything the process held; the exit response is recorded by onExit
    }),
  };
  return session;
}
