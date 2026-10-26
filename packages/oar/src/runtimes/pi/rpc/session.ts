/* oxlint-disable eslint/require-await -- Session controls return kernel promises directly; native delivery callbacks may decide synchronously. */
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { RequestRecord, ResponseBody, StartSession } from "../../../contracts/session.js";
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
  let running = false;
  let started = false;
  let pendingAbort = false;
  let disposeRequest: RequestRecord | null = null;
  let disposePromise: Promise<void> | null = null;
  let pump = Promise.resolve();
  const held: { input: string; inputId: string | undefined; images: readonly LoadedImage[] }[] = [];
  const fallback = createAbortFallback(() => { rpc.child.kill(); });
  const abort = async (): Promise<void> => {
    try {
      const response = await rpc.control.request({ type: "abort" });
      if (!response.success) { kernel.frame({ type: "pi/abort_rejected", native: response, events: [] }); }
    } catch { /* Exit and the bounded fallback are observed separately. */ }
  };
  const start = async (input: string, images: readonly LoadedImage[]): Promise<ResponseBody> => {
    if (running) { return { kind: "rejected", code: "busy", reason: "busy" }; }
    running = true;
    started = false;
    projection = piPrompted(projection);
    const response = await rpc.control.request({ type: "prompt", message: input, ...(images.length === 0 ? {} : { images: nativeImages(images) }) });
    if (!response.success) {
      running = false;
      pendingAbort = false;
      fallback.clear();
      return { kind: "rejected", code: "runtime_refused", reason: response.error };
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Native events can change started while the response is awaited.
    if (response.command === "prompt" && response.data.disposition === "handled" && !started) {
      // A slash command or input extension handled it without a model run.
      // Acceptance is native, but there is no turn end to invent.
      running = false;
      pendingAbort = false;
      fallback.clear();
      drain();
    }
    return { kind: "accepted" };
  };
  function drain(): void {
    if (running || kernel.unreachable() !== null) { return; }
    const next = held.shift();
    if (next === undefined) { return; }
    void (async (): Promise<void> => {
      try {
        const response = await start(next.input, next.images);
        if (response.kind === "rejected") {
          kernel.frame({ type: "pi/prompt_rejected", native: { inputId: next.inputId, reason: response.reason }, events: [] });
          drain();
        }
      } catch { /* Pending commands settle on process exit, which is recorded. */ }
    })();
  }
  const processMessage = async (message: Record<string, unknown>): Promise<void> => {
    if (message.type === "response") {
      const events = message.command === "get_state" && message.success === true
        ? [...(rpc.state.model === undefined ? [] : [{ kind: "model" as const, model: `${rpc.state.model.provider}/${rpc.state.model.id}` }]),
          { kind: "effort" as const, effort: rpc.state.thinkingLevel }]
        : [];
      kernel.frame({ type: "response", native: message, events });
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
      running = true;
      started = true;
      if (pendingAbort) { pendingAbort = false; void abort(); }
    }
    const overflow = event.type === "turn_end"
      ? event.message.role === "assistant" && event.message.stopReason === "error" && isContextOverflow(event.message)
      : event.type === "message_update" && event.assistantMessageEvent.type === "error" && isContextOverflow(event.assistantMessageEvent.error);
    let context: SessionStats["contextUsage"] = undefined;
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
    for (const command of next.commands) { kernel.frame(command.body); }
    if (event.type === "agent_settled") {
      running = false;
      started = false;
      pendingAbort = false;
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
  rpc.child.onExit((code) => {
    fallback.clear();
    running = false;
    held.splice(0);
    void (async (): Promise<void> => {
      await pump;
      kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
      rpc.directory.remove();
    })();
  });
  await pump;
  return credentials.seal({
    id: kernel.sessionId, capabilities,
    prompt: async (input, inputOptions) => kernel.control({ kind: "prompt", input, ...inputOptions }, async () => {
      if (running) { return { kind: "rejected", code: "busy", reason: "busy" }; }
      return withInputImages(capabilities, inputOptions?.images, async (images) => start(input, images));
    }),
    steer: async (input, inputOptions) => kernel.control({ kind: "steer", input, ...inputOptions }, async () => {
      if (!running) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
      return withInputImages(capabilities, inputOptions?.images, async (images): Promise<ResponseBody> => {
        const response = await rpc.control.request({ type: "steer", message: input, ...(images.length === 0 ? {} : { images: nativeImages(images) }) });
        return response.success ? { kind: "accepted" } : { kind: "rejected", code: "runtime_refused", reason: response.error };
      });
    }),
    queue: async (input, inputOptions) => kernel.control({ kind: "queue", input, ...inputOptions }, async () =>
      withInputImages(capabilities, inputOptions?.images, (images) => {
        held.push({ input, inputId: inputOptions?.inputId, images });
        drain();
        return { kind: "accepted" };
      })),
    withdraw: withdrawControl(kernel, held),
    abort: async () => kernel.control({ kind: "abort" }, () => {
      if (!running) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
      fallback.arm();
      if (started) { void abort(); } else { pendingAbort = true; }
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
