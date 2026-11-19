/* oxlint-disable import/max-dependencies -- The adapter composes protocol, input, projection and process-lifetime mechanisms. */
import { randomUUID } from "node:crypto";
import type { ControlResult, InputOptions, RequestRecord, ResponseBody, RuntimeEventBody, Session, StartSession } from "../../contracts/session.js";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { appendCleanupFailure } from "../../shared/executable/process-cleanup.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { withdrawHeld } from "../../shared/held-input.js";
import { manualCompaction } from "../../shared/manual-compaction.js";
import { withInputImages, type LoadedImage } from "../../shared/input-images.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { checkMcpServerNames, givenMcpServers, mcpCredentialRedactor } from "../../shared/mcp-servers.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { startDroidClient, type DroidClient, type DroidOutcome } from "./client.js";
import { checkFactoryLaunchArgs, factoryRefusedSessionOptions } from "./options.js";
import { contextOf, factoryOpenRequest, openFactory, serverReply } from "./open.js";
import { confirmSettings } from "./settings.js";
import { factoryCompaction } from "./compaction.js";
import { droidImages, type FactorySessionTimings, type Held } from "./session-state.js";
import { foldFactoryNotification, initialFactoryProjection, type FactoryProjection } from "./projection.js";

/*
 * Factory droid over its native stream-jsonrpc (docs/runtimes/factory.md):
 * one `droid exec` process per session; `initialize_session` or
 * `load_session` opens it; each prompt is one `add_user_message` whose
 * `messageId` is the turn id, and `agent_turn_completed` with that `turnId`
 * ends the turn. A second `add_user_message` during a turn is droid's own
 * steering: it queues the message (`end_of_turn`) and drains it into the
 * running turn, which still ends once, under the first turn id. An interrupt
 * discards steering not yet drained (`queued_messages_discarded`, by RPC id).
 * Every RPC OAR sends for an input uses the OAR request id as its JSON-RPC
 * id, so droid's echoes name the exact attempt.
 */

export const createFactorySession = (timings: FactorySessionTimings = {}): StartSession => withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") { throw new Error("The Factory droid session adapter needs an executable installation"); }
  refuseSessionOptions(factoryRefusedSessionOptions, options);
  checkFactoryLaunchArgs(options.launchArgs);
  const servers = givenMcpServers(options.mcpServers);
  if (servers !== null) { checkMcpServerNames(servers); }
  const { method, params } = factoryOpenRequest(options, servers);
  const redactMcp = mcpCredentialRedactor(options.mcpServers);
  const client: DroidClient = startDroidClient(installation.command, {
    cwd: options.cwd, env: sessionEnvironment(options.env), redact: (text) => credentials.redact(redactMcp(text)),
    ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }),
  });
  const cleanup: { reason?: string } = {};
  client.onExit((_code, reason) => { if (reason !== undefined) { cleanup.reason = reason; } });
  try {
    let recordOpen: (() => void) | null = null;
    const markOpen = (outcome: DroidOutcome): void => { if (outcome.kind === "result") { client.mark(() => recordOpen?.()); } };
    const opened = await openFactory(client, options, method, params, markOpen);
    const sessionId = options.resume ?? opened.sessionId;
    if (typeof sessionId !== "string") { throw new TypeError("droid initialize_session returned no sessionId"); }
    const settings = asRecord(opened.settings);
    const openEvents: RuntimeEventBody[] = [
      ...(typeof settings?.modelId === "string" ? [{ kind: "model" as const, model: settings.modelId }] : []),
      ...(typeof settings?.reasoningEffort === "string" ? [{ kind: "effort" as const, effort: settings.reasoningEffort }] : []),
    ];
    const kernel = credentials.kernel(sessionId);
    recordOpen = (): void => { kernel.frame({ type: method, native: opened, events: openEvents }); };

    let projection: FactoryProjection = initialFactoryProjection;
    /** The prompt OAR sent whose turn is running (its inputId is droid's turn id); null while idle or during a turn OAR did not prompt. */
    let active: { readonly request: RequestRecord; readonly inputId: string; dropped: boolean } | null = null;
    /** droid runs a turn OAR did not prompt: a steer that missed its turn's end starts a turn of its own. */
    let spontaneous = false;
    /** That turn's id when known: the missed steer's `messageId`. */
    let spontaneousTurn: string | null = null;
    /** The turn an accepted abort is waiting on; only its own end (or droid handing its prompt back) disarms the fallback. */
    let abortingTurn: string | null | false = false;
    let settingsWaiter: ((settings: JsonRecord) => void) | null = null;
    const held: Held[] = [];
    let dispatching = false;
    const abortFallback = createAbortFallback(() => { client.kill(); }, timings.abortFallbackMs);
    const disarm = (): void => { abortFallback.clear(); abortingTurn = false; };
    // A prompt droid handed back before starting it (an interrupt right after it) no longer holds the session; its late turn end still arrives.
    const busy = (): boolean => (active !== null && !active.dropped) || spontaneous;

    /** Record a reply OAR's own read received, whole and where it sat on the wire. */
    const recordReply = (type: string, events: (result: JsonRecord) => readonly RuntimeEventBody[] = () => [], responseTo?: string): ((outcome: DroidOutcome) => void) => (outcome: DroidOutcome): void => {
      if (outcome.kind === "exited") { return; }
      client.mark(() => { kernel.frame({ type, native: outcome.native, events: outcome.kind === "result" ? events(outcome.result) : [], ...(responseTo === undefined ? {} : { responseTo }) }); });
    };
    const readContext = (): void => {
      if (kernel.unreachable() !== null) { return; }
      void (async (): Promise<void> => {
        try {
          await client.request("droid.get_context_stats", {}, recordReply("droid.get_context_stats", (result) => {
            const context = contextOf(result);
            return context === null ? [] : [{ kind: "usage", usage: { context } }];
          }));
        } catch { /* Its reply, an error included, is already a frame; an exit is the exited response. */ }
      })();
    };

    const released = (): void => { queueMicrotask(drainHeld); };
    const onNotification = (message: JsonRecord): void => {
      const notification = asRecord(asRecord(message.params)?.notification);
      const wasBusy = busy();
      const extra: RuntimeEventBody[] = [];
      if (notification?.type === "droid_working_state_changed" && notification.newState !== "idle" && notification.newState !== "compacting_conversation" && active === null && !spontaneous && kernel.unreachable() === null) {
        spontaneous = true;
        extra.push({ kind: "turn_active" });
      }
      const { state, body } = foldFactoryNotification(projection, message);
      projection = state;
      const after: RuntimeEventBody[] = [];
      const prompted = active;
      if (prompted !== null && body.events.some(event => event.kind === "input_dropped" && event.requestId === prompted.request.id)) {
        prompted.dropped = true; // droid handed it back before starting it; its late cancelled end can no longer stall anything.
      }
      const ended = notification?.type === "agent_turn_completed";
      if (ended) {
        const turnId = typeof notification.turnId === "string" ? notification.turnId : undefined;
        if (abortingTurn !== false && (abortingTurn === null || turnId === undefined || turnId === abortingTurn)) { disarm(); }
        if (active !== null && (turnId === active.inputId || turnId === undefined)) { active = null; }
        else if (turnId === undefined || spontaneousTurn === null || turnId === spontaneousTurn) { spontaneous = false; spontaneousTurn = null; }
        // A steer droid neither echoed into this turn nor gave back missed it: droid starts a turn for it now, so the session stays busy until that turn ends.
        const missed = active === null && !spontaneous ? [...state.sent.values()][0] : undefined;
        if (missed !== undefined) {
          spontaneous = true;
          spontaneousTurn = missed.inputId;
          after.push({ kind: "turn_active", inputId: missed.inputId });
        }
      }
      const waiting = spontaneousTurn;
      if (!ended && waiting !== null && body.events.some(event => event.kind === "input_dropped" && event.inputId === waiting)) {
        // droid gave the missed steer back before its turn began (1.12.1 then still ends that turn, cancelled, under its id).
        spontaneous = false;
        spontaneousTurn = null;
      }
      const awaited = abortingTurn;
      // Any input droid hands back under the id an abort waits on: the abort was honored.
      if (typeof awaited === "string" && body.events.some(event => event.kind === "input_dropped" && event.inputId === awaited)) { disarm(); }
      kernel.frame(extra.length === 0 && after.length === 0 ? body : { ...body, events: [...extra, ...body.events, ...after] });
      if (notification?.type === "settings_updated") { settingsWaiter?.(asRecord(notification.settings) ?? {}); }
      if (ended) { readContext(); }
      if (ended || (wasBusy && !busy())) { released(); }
    };
    const onServerRequest = (message: JsonRecord): void => {
      const id = typeof message.id === "string" ? message.id : String(message.id);
      const requestMethod = typeof message.method === "string" ? message.method : "request";
      const requestParams = asRecord(message.params) ?? {};
      kernel.request("toApp", { kind: "native", type: requestMethod, native: message }, { id });
      const reply = serverReply(requestMethod, requestParams);
      client.respond(message.id, reply);
      kernel.respond(id, { kind: "answered", native: reply });
    };
    const capabilities = { queue: { durable: false }, attribution: "opaque", images: true } as const;
    const compaction = manualCompaction(kernel, {
      busy: () => busy() || dispatching || held.length > 0,
      busyReason: "droid compacts only between turns, after OAR's held input has been sent",
      // droid's compact_session answer (or refusal) is the end of the operation; its frame names the request.
      settledBy: "native_response",
      create: () => factoryCompaction(kernel, client, sessionId),
      released,
    });
    /** Send one input with `add_user_message`; the reply answers the control. */
    const send = async (request: RequestRecord, input: string, inputId: string, images: readonly LoadedImage[], starts: boolean): Promise<ResponseBody> => {
      projection = { ...projection, sent: new Map([...projection.sent, [request.id, { requestId: request.id, inputId }]]) };
      if (starts) { active = { request, inputId, dropped: false }; projection = { ...projection, turnId: inputId }; }
      // The reply line is a frame where it arrived; a refusal settles the input there too, before any later line (a turn end in the same chunk) is read.
      const settled = (outcome: DroidOutcome): void => {
        if (outcome.kind === "error" || outcome.kind === "exited") {
          if (starts && active?.request === request) { active = null; projection = { ...projection, turnId: null }; }
          const sent = new Map(projection.sent);
          sent.delete(request.id);
          projection = { ...projection, sent };
        }
        recordReply("droid.add_user_message", () => [], request.id)(outcome);
        if (starts && outcome.kind === "error") { released(); }
      };
      try {
        await client.request("droid.add_user_message", { text: input, messageId: inputId, ...droidImages(images) }, settled, request.id);
        return kernel.unreachable() ?? { kind: "accepted" };
      } catch (error) {
        return kernel.unreachable() ?? { kind: "rejected", code: "runtime_refused", reason: error instanceof Error ? error.message : String(error) };
      }
    };
    const drainHeld = (): void => {
      if (kernel.unreachable() !== null || busy() || dispatching || compaction.busy()) { return; }
      // Taken off `held` in the same step it is sent: a withdraw after this finds it gone.
      if (held[0]?.accepted !== true) { return; }
      const next = held.shift();
      if (next === undefined) { return; }
      dispatching = true;
      const request = kernel.request("toRuntime", { kind: "prompt", input: next.input,
        carries: [next.inputId ?? next.request.id], ...(next.images === undefined ? {} : { images: next.images }) });
      void (async (): Promise<void> => {
        try { kernel.respond(request.id, await send(request, next.input, next.inputId ?? randomUUID(), next.loaded, true)); }
        finally { dispatching = false; released(); }
      })();
    };

    client.handle({ onNotification, onServerRequest, onUnmatched: (native) => { kernel.frame({ type: asRecord(native) === null ? "stdout" : "response", native, events: [] }); } });
    client.onExit((code, reason) => {
      disarm();
      held.splice(0);
      kernel.processExited(code, reason);
      active = null;
      spontaneous = false;
      held.splice(0);
    });

    await confirmSettings(client, options, settings, recordReply("droid.update_session_settings"), (waiter) => { settingsWaiter = waiter; });
    readContext();

    const session: Session = credentials.seal({
      id: kernel.sessionId,
      capabilities,
      compact: compaction.compact,
      prompt: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        const inputId = inputOptions?.inputId ?? randomUUID();
        const result = await kernel.control({ kind: "prompt", input, ...inputOptions, inputId }, async (request) => {
          if (busy() || dispatching || held.length > 0 || compaction.busy()) { return { kind: "rejected", code: "busy", reason: "busy" }; }
          const decided = await withInputImages(capabilities, inputOptions?.images, async (loaded) => { const sent = await send(request, input, inputId, loaded, true); return sent; });
          return decided;
        });
        return result;
      },
      steer: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        const inputId = inputOptions?.inputId ?? randomUUID();
        const result = await kernel.control({ kind: "steer", input, ...inputOptions, inputId }, async (request) => {
          if (compaction.busy()) { return { kind: "rejected", code: "busy", reason: "droid is compacting the conversation" }; }
          if (!busy()) { return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }; }
          const decided = await withInputImages(capabilities, inputOptions?.images, async (loaded) => { const sent = await send(request, input, inputId, loaded, false); return sent; });
          return decided;
        });
        return result;
      },
      queue: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "queue", input, ...inputOptions }, request => withInputImages(capabilities, inputOptions?.images, (loaded) => {
          held.push({ inputId: inputOptions?.inputId, input, images: inputOptions?.images, loaded, request, accepted: false });
          return { kind: "accepted", queued: "adapter" };
        }));
        const entry = held.find(value => value.request.id === result.request.id);
        if (entry !== undefined) { entry.accepted = true; }
        drainHeld();
        return result;
      },
      withdraw: async (inputId): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "withdraw", inputId }, () => withdrawHeld(held, inputId));
        return result;
      },
      abort: async (): Promise<ControlResult> => {
        const result = await kernel.control({ kind: "abort" }, async (request) => {
          if (compaction.busy()) { return { kind: "rejected", code: "busy", reason: "droid cannot interrupt a manual compaction" }; }
          if (!busy()) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
          // Bounded: without droid's end of this turn in time, the process is stopped and its exit is recorded.
          abortingTurn = active !== null && !active.dropped ? active.inputId : spontaneousTurn;
          const refused = abortFallback.arm();
          try {
            await client.request("droid.interrupt_session", {}, recordReply("droid.interrupt_session", () => [], request.id));
            return { kind: "accepted" };
          } catch (error) {
            refused();
            return kernel.unreachable() ?? { kind: "rejected", code: "runtime_refused", reason: error instanceof Error ? error.message : String(error) };
          }
        });
        return result;
      },
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      resources: client.resources,
      dispose: async () => {
        await kernel.dispose(async () => {
          held.splice(0);
          // Closing stdin ends droid's session (it saves and exits); the process owner escalates if it does not.
          client.kill();
          await client.exited;
        });
      },
    });
    return session;
  } catch (error) {
    client.kill();
    await client.exited;
    throw appendCleanupFailure(error, cleanup.reason);
  }
});

export const factorySession: StartSession = createFactorySession();
