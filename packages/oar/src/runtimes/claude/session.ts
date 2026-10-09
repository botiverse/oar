/* oxlint-disable import/max-dependencies -- The adapter composes protocol, input and process-lifetime mechanisms. */
import type {
  ControlResult,
  InputOptions,
  RequestRecord,
  Session,
  StartSession,
} from "../../contracts/session.js";
import { randomUUID } from "node:crypto";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { withInputImages, type LoadedImage } from "../../shared/input-images.js";
import { withdrawControl } from "../../shared/held-input.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { claudeOpenSettings } from "./open-settings.js";
import { claudeContextBreakdownReader } from "./context-breakdown.js";
import { launchClaude, type ClaudeProcess } from "./launch.js";
import {
  claudeAbortRequested,
  claudePrompted,
  claudeUsageBaselined,
  foldClaudeStdout,
  initialClaudeProjection,
  resumedClaudeProjection,
  type ClaudeProjectionState,
} from "./projection.js";

/*
 * Stream-json writes can steer the active turn or land as the next turn;
 * native system/init ... result frames establish those boundaries. The
 * interrupt's control_response acknowledges abort, not turn completion.
 * The adapter owns pending controls and queue drain; projection owns facts.
 * Open readbacks are private plumbing: get_settings contains user config
 * and credentials, initialize and a resume's get_usage (its token baseline)
 * account details. All are consumed before projection, as is the unrecorded
 * contextBreakdown() query answer.
 * Native mappings and live evidence: docs/runtimes/claude.md.
 */

/** One stream-json user message; images go before the text, as the Messages API recommends. */
function userMessage(text: string, inputId?: string, images: readonly LoadedImage[] = []): string {
  return `${JSON.stringify({
    type: "user",
    ...(inputId === undefined ? {} : { uuid: inputId }),
    message: {
      role: "user",
      content: [
        ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
        ...(text === "" ? [] : [{ type: "text", text }]),
      ],
    },
  })}\n`;
}

interface ClaudeSessionState {
  child: ClaudeProcess;
  /** The prompt request whose turn is running; null while idle. Spontaneous turns (a drained queue message) run with no request. */
  active: RequestRecord | null;
  /** True while claude is executing a turn we did not prompt (queue drain). */
  spontaneous: boolean;
  projection: ClaudeProjectionState;
  disposed: boolean;
}

export const claudeSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") {
    throw new Error("The claude session adapter needs an executable installation");
  }
  // Session identity is claude's own: we either choose it up front
  // (--session-id) or reattach to an existing one (--resume), so Session.id
  // is always the runtime-native persistent id.
  const sessionId = options.resume ?? randomUUID();
  const child = await launchClaude(installation.command, sessionId, options);

  const kernel = credentials.kernel(sessionId);
  const state: ClaudeSessionState = {
    child,
    active: null,
    spontaneous: false,
    projection: options.resume === undefined ? initialClaudeProjection : resumedClaudeProjection,
    disposed: false,
  };
  // claude cannot hold input for a LATER turn natively (an active-turn write
  // steers), so queueing is adapter-held: drained one message per turn end,
  // and an entry can be withdrawn by its inputId until then.
  const heldQueue: { input: string; inputId?: string; images: readonly LoadedImage[] }[] = [];
  const busy = (): boolean => state.active !== null || state.spontaneous;
  const abortFallback = createAbortFallback(() => { child.kill(); });
  const pendingInterrupts = new Map<string, () => void>();
  let disposeRequest: RequestRecord | null = null;
  const readback = claudeOpenSettings(child);
  const contextBreakdown = claudeContextBreakdownReader(child);

  // Drive the pure projection fold, applying its commands to the kernel. The
  // fold owns event translation and attribution; this owns only transport
  // and the control decisions (busy, queue drain).
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    if (readback.consume(message) || contextBreakdown.consume(message)) { return; }
    // A system/init while nothing is active is claude starting a turn on its
    // own (a queued or late-steered message): a spontaneous turn.
    if (message.type === "system" && message.subtype === "init" && !busy()) {
      state.spontaneous = true;
    }
    const { state: nextProjection, commands } = foldClaudeStdout(state.projection, message);
    state.projection = nextProjection;
    let ended = false;
    for (const command of commands) {
      switch (command.kind) {
        case "frame": {
          const record = kernel.frame(command.body, { agentPath: command.agentPath });
          if (record.agentPath.length === 0 && command.body.events.some((event) => event.kind === "turn_ended")) {
            ended = true;
          }
          break;
        }
        case "respond": {
          const refused = pendingInterrupts.get(command.requestId);
          if (refused !== undefined) {
            pendingInterrupts.delete(command.requestId);
            if (command.body.kind === "rejected") { refused(); }
            kernel.respond(command.requestId, command.body);
          } else {
            // Exit may precede the last stdout bytes. Preserve a late or
            // duplicate native reply, but never answer a request twice.
            kernel.frame({ type: "control_response", native: message, events: [] });
          }
          break;
        }
        case "toApp":
          kernel.request("toApp", { kind: "native", type: command.type, native: command.native }, { id: command.id });
          break;
        default:
          break;
      }
    }
    if (ended) {
      abortFallback.clear();
      state.active = null;
      state.spontaneous = false;
      if (!state.disposed) {
        const next = heldQueue.shift();
        if (next !== undefined) {
          child.write(userMessage(next.input, next.inputId, next.images));
        }
      }
    }
  });
  child.onExit((code) => {
    abortFallback.clear();
    // An exit before fallback still precedes the rejected pending controls.
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
    state.active = null;
    state.spontaneous = false;
    for (const requestId of pendingInterrupts.keys()) {
      pendingInterrupts.delete(requestId);
      kernel.respond(requestId, { kind: "rejected", code: "runtime_exited", reason: "runtime exited" });
    }
    readback.exited(code);
    contextBreakdown.exited();
  });

  await readback.confirm(options);
  if (options.resume !== undefined) {
    // Before the first turn: where this Session's share of the running total
    // the resumed process continues starts (token-usage.ts).
    state.projection = claudeUsageBaselined(state.projection, await readback.usageBaseline());
  }

  let interruptCounter = 0;
  const capabilities = { queue: { durable: false }, attribution: "attributed", images: true } as const;
  const session: Session = credentials.seal({
    id: kernel.sessionId,
    capabilities,
    prompt: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const body = { kind: "prompt" as const, input, ...inputOptions };
      const result = await kernel.control(body, (request) => {
      if (busy()) {
        return { kind: "rejected", code: "busy", reason: "busy" };
      }
      return withInputImages(capabilities, inputOptions?.images, (images) => {
        state.active = request;
        state.projection = claudePrompted(state.projection);
        child.write(userMessage(input, inputOptions?.inputId, images));
        return { kind: "accepted" };
      });
      });
      return result;
    },
    steer: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "steer", input, ...inputOptions }, () => {
      if (!busy()) {
        return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" };
      }
      return withInputImages(capabilities, inputOptions?.images, (images) => {
        child.write(userMessage(input, inputOptions?.inputId, images));
        return { kind: "accepted" };
      });
      });
      return result;
    },
    queue: async (input, inputOptions?: InputOptions): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "queue", input, ...inputOptions }, () =>
        withInputImages(capabilities, inputOptions?.images, (images) => {
          if (busy()) {
            heldQueue.push({ input, ...(inputOptions?.inputId === undefined ? {} : { inputId: inputOptions.inputId }), images });
          } else {
            child.write(userMessage(input, inputOptions?.inputId, images));
          }
          return { kind: "accepted" };
        }));
      return result;
    },
    withdraw: withdrawControl(kernel, heldQueue),
    abort: async (): Promise<ControlResult> => {
      // The interrupt's outcome is claude's control_response, which the fold
      // routes to THIS request id; the turn's end is claude's result frame.
      interruptCounter += 1;
      const requestId = `interrupt-${interruptCounter}`;
      // Recorded by hand (not kernel.control) because claude's control_response
      // is the answer, routed to this id by the fold, so the reachability gate
      // is applied here explicitly.
      const blocked = kernel.unreachable();
      const request = kernel.request("toRuntime", { kind: "abort" }, { id: requestId });
      if (blocked !== null || !busy()) {
        return { request, response: kernel.respond(request.id, blocked ?? { kind: "rejected", code: "no_active_turn", reason: "no active turn" }) };
      }
      state.projection = claudeAbortRequested(state.projection);
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
        request: { subtype: "interrupt" },
      })}\n`);
      const result = await promise;
      unsubscribe();
      return result;
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    resources: child.resources,
    contextBreakdown: contextBreakdown.read,
    dispose: async () => {
      if (state.disposed) {
        return;
      }
      state.disposed = true;
      // stdin ends now: no query may write to it any more.
      contextBreakdown.exited();
      const gone = kernel.unreachable() !== null; // only an observed exit can say so before this dispose is recorded
      disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
      if (gone) {
        // The exit is already recorded; nothing is left to release.
        kernel.respond(disposeRequest.id, { kind: "accepted" });
        return;
      }
      child.kill();
      await child.exited; // release point for anything the process held; the exit response is recorded by onExit
    },
  });
  return session;
});
