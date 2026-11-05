/* oxlint-disable import/max-dependencies -- Session controls compose native startup, projection, input admission, compaction and lifecycle. */
import { piManualCompaction } from "../compaction.js";
import { handledInput, refusedInput, startedInput, type PiHeldInput } from "../input-disposition.js";
/* oxlint-disable eslint/require-await -- Session controls return kernel promises directly; native delivery callbacks may decide synchronously. */
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { RequestRecord, ResponseBody, RuntimeEventBody, StartSession } from "../../../contracts/session.js";
import { createAbortFallback } from "../../../shared/abort-fallback.js";
import { withdrawControl } from "../../../shared/held-input.js";
import { withInputImages, type LoadedImage } from "../../../shared/input-images.js";
import { withSessionCredentials } from "../../../shared/session-credentials.js";
import { foldPiEvent, initialPiProjection, piPrompted } from "../projection.js";
import type { PiRuntimeOptions } from "../options.js";
import { openPiRpc } from "./open.js";

const nativeImages = (images: readonly LoadedImage[]): { type: "image"; data: string; mimeType: string }[] => images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mediaType }));

/** One bundled native RPC process per session; Pi's event fold is shared with the SDK path. */
export const createPiRpcSession = (runtime: PiRuntimeOptions): StartSession => withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "bundled") { throw new Error("Pi RPC needs the bundled SDK installation"); }
  const { isContextOverflow } = await import("@earendil-works/pi-ai");
  const buffered: Record<string, unknown>[] = [];
  let receive = (message: Record<string, unknown>): void => { buffered.push(message); };
  const rpc = await openPiRpc(options, credentials, (message) => { receive(message); }, runtime);
  const kernel = credentials.kernel(rpc.state.sessionId);
  const capabilities = { queue: { durable: false }, attribution: "none", images: true } as const;
  let projection = initialPiProjection;
  interface Admission { readonly request: RequestRecord; readonly queued: boolean; abort: boolean }
  const admissions = new Map<string, Admission>();
  const commands = new Map<string, { readonly request: RequestRecord; readonly queued: boolean }>();
  let nativeActive = false;
  let nextOwner: Admission | null = null;
  const busy = (): boolean => nativeActive || admissions.size > 0;
  let disposeRequest: RequestRecord | null = null;
  let disposePromise: Promise<void> | null = null;
  let pump = Promise.resolve();
  const compaction = piManualCompaction(kernel, () => busy() || held.length > 0, async () => {
    // A rejected transport promise is not a native compaction failure. The
    // process exit below settles the caller after its final stdout is folded.
    const response = await rpc.control.request({ type: "compact" }).catch(() => null);
    if (response === null) { return; }
    await pump;
    if (!response.success) { throw new Error(response.error); }
  }, () => { queueMicrotask(drain); });
  const held: PiHeldInput[] = [];
  const fallback = createAbortFallback(() => { rpc.child.kill(); });
  const abort = async (): Promise<void> => {
    try {
      const response = await rpc.control.request({ type: "abort" });
      if (!response.success) { kernel.frame({ type: "pi/abort_rejected", native: response, events: [] }); }
    } catch { /* Exit and the bounded fallback are observed separately. */ }
  };
  const start = async (request: RequestRecord, input: string, images: readonly LoadedImage[], queued = false): Promise<ResponseBody> => {
    admissions.set(request.id, { request, queued, abort: false });
    const response = await rpc.control.request({ type: "prompt", message: input, ...(images.length === 0 ? {} : { images: nativeImages(images) }) },
      id => { commands.set(id, { request, queued }); });
    // The raw response owns both disposition and gate release. Fold it before
    // publishing the control decision, without inventing a second native frame.
    await pump;
    return response.success ? { kind: "accepted" } : { kind: "rejected", code: "runtime_refused", reason: response.error };
  };
  function drain(): void {
    if (busy() || compaction.busy() || kernel.unreachable() !== null) { return; }
    if (held[0]?.accepted !== true) { return; }
    const next = held.shift();
    if (next === undefined) { return; }
    void (async (): Promise<void> => {
      const { inputId: _inputId, ...body } = next.body;
      await kernel.control({ ...body, kind: "prompt", admission: "native", carries: [next.inputId ?? next.requestId] },
         async request => { const response = await start(request, next.body.input, next.images, true); return response; });
      drain();
    })();
  }
  const processMessage = async (message: Record<string, unknown>): Promise<void> => {
    if (message.type === "response") {
      const events: RuntimeEventBody[] = message.command === "get_state" && message.success === true
        ? [...(rpc.state.model === undefined ? [] : [{ kind: "model" as const, model: `${rpc.state.model.provider}/${rpc.state.model.id}` }]),
          { kind: "effort" as const, effort: rpc.state.thinkingLevel }]
        : [];
      const command = typeof message.id === "string" ? commands.get(message.id) : undefined;
      if (command !== undefined) {
        const data = typeof message.data === "object" && message.data !== null && "disposition" in message.data ? message.data.disposition : undefined;
        if (message.success === false || data === "handled") {
          admissions.delete(command.request.id);
          if (!busy()) { fallback.clear(); }
          if (data === "handled") { events.push(handledInput(command.request)); }
          if (message.success === false && command.queued) {
            events.push(refusedInput(command.request, typeof message.error === "string" ? message.error : "pi prompt failed"));
          }
        } else if (data === "started") {
          nextOwner = admissions.get(command.request.id) ?? null;
          events.push(startedInput(command.request));
        }
        if (typeof message.id === "string") { commands.delete(message.id); }
      }
      kernel.frame({ type: "response", native: message, events, ...(command === undefined ? {} : { responseTo: command.request.id }) });
      return;
    }
    if (message.type === "extension_ui_request") {
      kernel.request("toApp", { kind: "native", type: "extension_ui_request", native: message }, typeof message.id === "string" ? { id: message.id } : {});
      if (["select", "confirm", "input", "editor"].includes(String(message.method))) {
        rpc.child.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`);
      }
      return;
    }
    if (typeof message.type !== "string") { return; }
    // Both the bundled SDK and its own RPC encoder carry AgentSessionEvent.
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- AgentSessionEvent is the pinned bundled RPC encoder's native payload.
    const event = message as unknown as AgentSessionEvent;
    if (event.type === "agent_start") {
      nativeActive = true;
      projection = piPrompted(projection);
      const owner = nextOwner;
      nextOwner = null;
      const aborted = owner?.abort === true || [...admissions.values()].some(admission => admission.abort);
      for (const admission of admissions.values()) { admission.abort = false; }
      if (owner !== null) { admissions.delete(owner.request.id); }
      if (aborted) { fallback.arm(); void abort(); }
    }
    const overflow = event.type === "turn_end"
      ? event.message.role === "assistant" && event.message.stopReason === "error" && isContextOverflow(event.message)
      : event.type === "message_update" && event.assistantMessageEvent.type === "error" && isContextOverflow(event.assistantMessageEvent.error);
    let context: SessionStats["contextUsage"] = undefined;
    if (event.type === "compaction_end" && event.reason === "manual") { fallback.clear(); }
    if (event.type === "agent_settled") {
      fallback.clear();
      try {
        const response = await rpc.control.request({ type: "get_session_stats" });
        if (response.success && response.command === "get_session_stats") { context = response.data.contextUsage; }
      }
      catch { /* An exit may race settlement. Keep the native boundary even without a stats reply. */ }
    }
    const next = foldPiEvent(projection, event, { overflow, ...(context === undefined ? {} : { context }) });
    projection = next.state;
    for (const command of next.commands) {
      const unstarted = event.type === "agent_settled" && !nativeActive ? nextOwner : null;
      kernel.frame(unstarted === null ? command.body : { ...command.body,
        events: [...command.body.events, refusedInput(unstarted.request, "Pi settled before agent_start")] });
    }
    if (event.type === "agent_settled") {
      // Abort can rearm this while stats are awaited or observers run.
      fallback.clear();
      if (nextOwner !== null) { admissions.delete(nextOwner.request.id); nextOwner = null; }
      nativeActive = false;
      drain();
    }
  };
  receive = (message): void => {
    const previous = pump;
    pump = (async (): Promise<void> => {
      try { await previous; await processMessage(message); }
      catch (error) {
        kernel.frame({ type: "pi/rpc_error", native: { message: error instanceof Error ? error.message : String(error) }, events: [] });
        rpc.child.kill();
      }
    })();
  };
  for (const message of buffered) { receive(message); }
  rpc.child.onExit((code, reason) => {
    fallback.clear();
    nativeActive = false;
    admissions.clear();
    commands.clear();
    held.splice(0);
    void (async (): Promise<void> => {
      await pump;
      kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code, ...(reason === undefined ? {} : { reason }) });
      rpc.directory.remove();
    })();
  });
  await pump;
  return credentials.seal({
    id: kernel.sessionId, capabilities,
    compact: compaction.compact,
    prompt: async (input, inputOptions) => {
      const result = await kernel.control({ kind: "prompt", input, ...inputOptions, admission: "native" }, async (request) => {
        if (busy() || held.length > 0 || compaction.busy()) { return { kind: "rejected", code: "busy", reason: "busy" }; }
        return withInputImages(capabilities, inputOptions?.images, async (images) => start(request, input, images));
      });
      // A pre-start refusal has no settlement; record it before draining.
      drain();
      return result;
    },
    steer: async (input, inputOptions) => kernel.control({ kind: "steer", input, ...inputOptions }, async (request) => {
      if (compaction.busy()) { return { kind: "rejected", code: "busy", reason: "Manual compaction is still in progress" }; }
      if (!busy()) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
      return withInputImages(capabilities, inputOptions?.images, async (images): Promise<ResponseBody> => {
        const response = await rpc.control.request({ type: "steer", message: input, ...(images.length === 0 ? {} : { images: nativeImages(images) }) },
          id => { commands.set(id, { request, queued: false }); });
        await pump;
        return response.success ? { kind: "accepted" } : { kind: "rejected", code: "runtime_refused", reason: response.error };
      });
    }),
    queue: async (input, inputOptions) => {
      const body = { kind: "queue" as const, input, ...inputOptions };
      const result = await kernel.control(body, request => withInputImages(capabilities, inputOptions?.images, images => {
        held.push({ body, requestId: request.id, inputId: inputOptions?.inputId, images });
        return { kind: "accepted", queued: "adapter" };
      }));
      const queued = held.find(entry => entry.requestId === result.request.id);
      if (queued !== undefined) { queued.accepted = true; }
      drain();
      return result;
    },
    withdraw: withdrawControl(kernel, held),
    abort: async () => kernel.control({ kind: "abort" }, () => {
      if (compaction.busy() && !compaction.admitted()) { return { kind: "rejected", code: "busy", reason: "Pi has not yet started the compaction that abort would cancel" }; }
      if (!busy() && !compaction.busy()) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
      if (nativeActive || compaction.busy()) { fallback.arm(); void abort(); } else { for (const admission of admissions.values()) { admission.abort = true; } }
      return { kind: "accepted" };
    }),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(), graph: () => kernel.graph(), resources: rpc.child.resources,
    dispose: async () => {
      disposePromise ??= (async (): Promise<void> => {
        disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
        held.splice(0);
        // Native EOF shuts extensions down; the process owner snapshots
        // descendants first, then bounds shutdown and removes survivors.
        rpc.child.kill();
        await rpc.child.exited;
        await pump;
        rpc.directory.remove();
      })();
      return disposePromise;
    },
  });
});
