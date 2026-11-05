/* oxlint-disable import/max-dependencies -- Session controls compose native startup, projection, input admission, compaction and lifecycle. */
import { piManualCompaction } from "./compaction.js";
import { handledInput, refusedInput, startedInput, type PiHeldInput } from "./input-disposition.js";
import type {
  RequestRecord, ContextUsage, ControlResult, InputOptions, ResponseBody, Session, StartSession } from "../../contracts/session.js";
import type { PiProjectOptions } from "./options.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { withdrawControl } from "../../shared/held-input.js";
import { withInputImages, type LoadedImage } from "../../shared/input-images.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import {
  foldPiEvent,
  initialPiProjection,
  piPrompted,
  type PiProjectionState,
} from "./projection.js";
import { disposePiAgentSession } from "./lifecycle.js";
import { openPiAgentSession, piEffectiveModel } from "./open.js";

/** pi's ImageContent: base64 data and its type. */
const piImages = (images: readonly LoadedImage[]): { type: "image"; data: string; mimeType: string }[] =>
  images.map((image) => ({ type: "image", data: image.data, mimeType: image.mediaType }));

export { piEffectiveModel, piEnvBashTool, type PiModelSource } from "./open.js";

/*
 * Bundled pi SDK mapping (in-process, no fork; settled 2026-08-21, record
 * stream 2026-09-11): every SDK event is one frame; pi's own
 * `agent_settled` is the turn end; steer acceptance means entry into pi's queue;
 * abort is cooperative. Resume opens the cwd's session file by id and
 * options.model resolves through the ModelRuntime (see resolve.ts);
 * options.effort is pi's creation-time thinking level (open.ts).
 * Process-global lazy env reads mean another embedded pi cannot safely share
 * this process.
 */

export const createPiSession = (project: PiProjectOptions = {}): StartSession => withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "bundled") {
    throw new Error("The pi session adapter needs the bundled sdk installation");
  }
  const earlyErrors: unknown[] = [];
  let extensionError = (native: unknown): void => { earlyErrors.push(native); };
  const piAgentSession = await openPiAgentSession(options, credentials.add, project, native => { extensionError(native); });
  // pi-ai's own test for an oversized context, on a failed assistant message (failure.ts).
  const { isContextOverflow } = await import("@earendil-works/pi-ai");
  const overflowOf = (event: Parameters<Parameters<typeof piAgentSession.subscribe>[0]>[0]): boolean => {
    if (event.type === "turn_end") {
      return event.message.role === "assistant" && event.message.stopReason === "error" && isContextOverflow(event.message);
    }
    return event.type === "message_update" && event.assistantMessageEvent.type === "error" && isContextOverflow(event.assistantMessageEvent.error);
  };

  const kernel = credentials.kernel(piAgentSession.sessionId);
  extensionError = (native): void => { kernel.frame({ type: "extension_error", native, events: [] }); };
  earlyErrors.forEach(native => { extensionError(native); });
  // abort() signals synchronously, then waits for idle. Accept delivery now;
  // its later settlement is a native event, never a control-intent inference.
  const abortNative = async (): Promise<void> => {
    try {
      await piAgentSession.abort();
    } catch (error) {
      kernel.frame({ type: "pi/abort_rejected", native: { message: error instanceof Error ? error.message : String(error) }, events: [] });
    }
  };
  let projection: PiProjectionState = initialPiProjection;
  // Preflight belongs to a request; a native run can also start independently
  // from an extension while that preflight is awaiting its input hook.
  interface Admission { readonly request: RequestRecord; abort: boolean }
  const admissions = new Map<string, Admission>();
  let nativeActive = false;
  let nextOwner: Admission | null = null;
  let nativeOwner: Admission | null = null;
  let disposeRequest: RequestRecord | null = null;
  const held: PiHeldInput[] = [];
  const busy = (): boolean => nativeActive || admissions.size > 0;
  const compaction = piManualCompaction(kernel, () => busy() || held.length > 0,
    async () => { await piAgentSession.compact(); }, () => { queueMicrotask(drainHeld); });

  // pi is authoritative on context fullness: getContextUsage() returns
  // tokens (null right after compaction, before the next response),
  // contextWindow, percent. Read at agent_end so the turn-end record carries
  // it and Session.contextUsage() (a fold) is current at turn end (which
  // is agent_settled, after any threshold compaction; see projection.ts).
  const contextOf = (): ContextUsage | null => {
    const usage = piAgentSession.getContextUsage();
    return usage === undefined
      ? null
      : { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
  };

  const start = async (request: RequestRecord, input: string, images: readonly LoadedImage[], queued = false): Promise<ResponseBody> => {
    const admission: Admission = { request, abort: false };
    admissions.set(request.id, admission);
    const decision = { ...Promise.withResolvers<ResponseBody>(), settled: false };
    const run = piAgentSession.prompt(input, {
      ...(images.length === 0 ? {} : { images: piImages(images) }),
      preflightResult: (disposition) => {
        if (decision.settled) { return; }
        decision.settled = true;
        if (disposition === "started") {
          nextOwner = admission;
        } else {
          admissions.delete(request.id);
        }
        // The callback is native evidence even when no SDK event is emitted.
        // Release only this admission before publishing its receipt.
        kernel.frame({ type: "pi/preflight_result", native: { disposition }, responseTo: request.id,
          events: disposition === "handled" ? [handledInput(request)] : (disposition === "started" ? [startedInput(request)] : []) });
        decision.resolve({ kind: "accepted" });
      },
    });
    // A prompt deferred by Pi during settlement can resolve before preflight.
    // Only its callback accepts it; promise fulfillment is not evidence.
    void (async (): Promise<void> => {
      try { await run; } catch (error) {
        const reason = error instanceof Error ? error.message : "pi prompt failed";
        if (!decision.settled) {
          decision.settled = true;
          admissions.delete(request.id);
          kernel.frame({ type: "pi/prompt_rejected", native: { message: reason }, responseTo: request.id,
            events: queued ? [refusedInput(request, reason)] : [] });
          decision.resolve({ kind: "rejected", code: "runtime_refused", reason });
        } else if (nativeOwner === admission && nativeActive) {
          nativeActive = false;
          nativeOwner = null;
          admissions.delete(request.id);
          kernel.frame({ type: "pi/prompt_rejected", native: { message: reason }, responseTo: request.id,
            events: [{ kind: "turn_ended", outcome: { kind: "failed", reason, failure: classifyFailure(reason) } }] });
          drainHeld();
        }
      }
    })();
    const response = await decision.promise;
    return kernel.unreachable() ?? response;
  };
  function drainHeld(): void {
    if (disposeRequest !== null || busy() || compaction.busy() || kernel.unreachable() !== null) { return; }
    if (held[0]?.accepted !== true) { return; }
    const next = held.shift();
    if (next === undefined) { return; }
    void (async (): Promise<void> => {
      const { inputId: _inputId, ...body } = next.body;
      await kernel.control({ ...body, kind: "prompt", admission: "native", carries: [next.inputId ?? next.requestId] },
         async request => { const response = await start(request, next.body.input, next.images, true); return response; });
      // Handled inputs and native preflight refusals have no turn end.
      drainHeld();
    })();
  }

  // Drive the pure projection fold: one SDK event → one frame. The
  // fold owns events and outcome classification; this owns the run gate.
  piAgentSession.subscribe((event) => {
    if (event.type === "agent_start") {
      nativeActive = true;
      nativeOwner = nextOwner;
      nextOwner = null;
      projection = piPrompted(projection);
      if (nativeOwner !== null) { admissions.delete(nativeOwner.request.id); }
      if (nativeOwner?.abort === true) { nativeOwner.abort = false; void abortNative(); }
    }
    const extra = event.type === "agent_settled" ? { context: contextOf() } : { overflow: overflowOf(event) };
    const { state: nextProjection, commands } = foldPiEvent(projection, event, extra);
    projection = nextProjection;
    for (const command of commands) {
      kernel.frame(command.body);
      if (command.body.events.some((item) => item.kind === "turn_ended")) {
        nativeActive = false;
        nativeOwner = null;
        drainHeld();
      }
    }
  });

  const openedModel = piEffectiveModel(piAgentSession);
  if (openedModel !== null) {
    // The SDK's own report of the model and thinking level in effect at open,
    // captured as the runtime's word (never the request echoed: the mismatch
    // checks in open.ts already rejected a request pi did not apply).
    const { thinkingLevel } = piAgentSession;
    kernel.frame({
      type: "pi/session_opened",
      native: { sessionId: piAgentSession.sessionId, model: openedModel, thinkingLevel },
      events: [{ kind: "model", model: openedModel }, { kind: "effort", effort: thinkingLevel }],
    });
  }

  const capabilities = { queue: { durable: false }, attribution: "none", images: true } as const;
  const session: Session = credentials.seal({
    id: kernel.sessionId,
    capabilities,
    compact: compaction.compact,
    prompt: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const body = { kind: "prompt" as const, input, ...inputOptions, admission: "native" as const };
      const result = await kernel.control(body, async (request) => {
        if (busy() || held.length > 0 || compaction.busy()) {
          return { kind: "rejected", code: "busy", reason: "busy" };
        }
        const decided = await withInputImages(capabilities, inputOptions?.images, async (images) => {
          const started = await start(request, input, images);
          return started;
        });
        return decided;
      });
      // A pre-start refusal has no settlement to release queued work.
      // Publish its response before dispatching the next input.
      drainHeld();
      return result;
    },
    steer: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "steer", input, ...inputOptions }, async (request) => {
        if (compaction.busy()) { return { kind: "rejected", code: "busy", reason: "Manual compaction is still in progress" }; }
        if (!busy()) {
          return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" };
        }
        const decided = await withInputImages(capabilities, inputOptions?.images, async (images): Promise<ResponseBody> => {
          const disposition = await piAgentSession.steer(input, images.length === 0 ? undefined : piImages(images));
          kernel.frame({ type: "pi/steer_result", native: { disposition }, responseTo: request.id,
            events: disposition === "handled" ? [handledInput(request)] : [] });
          return { kind: "accepted" };
        });
        return decided;
      });
      return result;
    },
    queue: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const body = { kind: "queue" as const, input, ...inputOptions };
      const result = await kernel.control(body, request =>
        withInputImages(capabilities, inputOptions?.images, (images) => {
          held.push({ body, requestId: request.id, inputId: inputOptions?.inputId, images });
          return { kind: "accepted", queued: "adapter" };
        }));
      const queued = held.find(entry => entry.requestId === result.request.id);
      if (queued !== undefined) { queued.accepted = true; }
      drainHeld();
      return result;
    },
    withdraw: withdrawControl(kernel, held),
    abort: async (): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "abort" }, () => {
        if (compaction.busy() && !compaction.admitted()) { return { kind: "rejected", code: "busy", reason: "Pi has not yet started the compaction that abort would cancel" }; }
        if (!busy() && !compaction.busy()) {
          return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
        }
        // Use the complete SDK cancellation path, including its run-aborted
        // flag, retries, compaction and branch summaries. Before agent_start,
        // hold the intent until Pi has created the run that owns that flag.
        if (piAgentSession.isStreaming || compaction.busy()) {
          void abortNative();
        } else {
          for (const admission of admissions.values()) { admission.abort = true; }
        }
        return { kind: "accepted" };
      });
      return result;
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      if (disposeRequest !== null) {
        return;
      }
      held.splice(0);
      const abortCompaction = compaction.busy();
      const request = kernel.request("toRuntime", { kind: "dispose" });
      disposeRequest = request;
      // Abort and hooks share a deadline. Only Pi's own agent_settled ends a
      // turn in the stream; forced local cleanup invents no native end.
      await disposePiAgentSession(piAgentSession, busy() || abortCompaction);
      // pi runs in this process: there is no process exit to observe, so the
      // dispose is answered as taken over rather than with an exit code.
      kernel.respond(request.id, { kind: "accepted" });
    },
  });
  return session;
}, "in_process");

export const piSession = createPiSession();
