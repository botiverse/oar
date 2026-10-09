/* oxlint-disable import/max-dependencies -- The adapter composes protocol, input and process-lifetime mechanisms. */
import { randomUUID } from "node:crypto";
import type { ControlResult, InputOptions, RequestRecord, Session, StartSession } from "../../contracts/session.js";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { acceptCodexSteer, codexUserInput } from "./input-delivery.js";
import { inputImagesRefusal } from "../../shared/input-images.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { startAppServerClient, type RpcOutcome } from "./app-server-client.js";
import { CODEX_SETTINGS_REPORT_MS, codexOpenReadback, codexResumeEffortRefusal, codexThreadOpen } from "./open.js";
import { foldCodexNotification, initialCodexProjection, type CodexProjectionState } from "./projection.js";
import { prepareCodexToolDenials } from "./tool-denials.js";
import { openThread, rpcControl, type RpcControlPlan } from "./rpc-control.js";

/*
 * App-server v2: RPC replies answer controls; notifications carry facts.
 * Record replies synchronously, before later notifications in the same chunk.
 * Model/effort read-back and resume overrides live in open.ts. Reachability
 * comes from the recorded exit/dispose, never a separate liveness flag.
 * Native mappings and live evidence: docs/runtimes/codex.md.
 */

interface CodexSessionState {
  /** The prompt request whose turn is running; null while idle or during a spontaneous turn. */
  active: RequestRecord | null;
  /** True while codex runs a root turn we did not prompt (a drained queue submission). */
  spontaneous: boolean;
  /** The runtime's id for the active root turn; steer/abort identity. */
  codexTurnId: string | null;
  projection: CodexProjectionState;
}
export const codexSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") {
    throw new Error("The codex session adapter needs an executable installation");
  }
  // Threads persist so a later SessionOptions.resume can reattach; the thread
  // id is the runtime-native identity and becomes Session.id (open.ts builds
  // the request, and refuses what it cannot build before anything starts).
  const { method: openMethod, params: openParams, redact } = codexThreadOpen(options);
  // YOLO default (repo policy 2026-08-24): bypass the sandbox too, not just
  // approvals; OAR_CODEX_SANDBOX pins a stricter mode when a host wants one.
  // Injected as a launch -c override (app-server-client.ts). A host that
  // wants the user's own config to win can set OAR_CODEX_SANDBOX=inherit to
  // skip the override entirely.
  const sandboxMode = process.env.OAR_CODEX_SANDBOX ?? "danger-full-access";
  const configOverrides = sandboxMode === "inherit" ? {} : { sandbox_mode: `"${sandboxMode}"` };
  // Every error the client reports goes through the redactor first: the
  // open's config carries the session's MCP credentials to codex.
  const client = startAppServerClient(installation.command, options.env, configOverrides, undefined, { redact, ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }) });
  await client.request("initialize", {
    clientInfo: { name: "oar", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  const filteredOpenParams = await prepareCodexToolDenials(client, options, openParams);
  // The open event is marked at the reply's wire position AS the reply line
  // is read (onSettled → client.mark), not after this await: a frame codex
  // wrote in the same chunk right after the reply (thread/started) would
  // otherwise precede it. The mark runs when the handlers register below,
  // once the kernel exists; a failed open registers none, so it never runs.
  let recordOpen: (() => void) | null = null;
  const markOpen = (outcome: RpcOutcome): void => {
    if (outcome.kind === "result") {
      client.mark(() => recordOpen?.());
    }
  };
  const started = await openThread(client, openMethod, async () => {
    const reply = await client.request(openMethod, filteredOpenParams, markOpen);
    return reply;
  }, options.serviceTier);
  const threadId = asRecord(started.thread)?.id;
  if (typeof threadId !== "string") {
    client.kill();
    throw new TypeError("codex thread start/resume returned no thread id");
  }
  // The reply is codex's word on the model and effort the thread runs (the
  // open frame's events); anything but what was requested refuses the open.
  const readback = codexOpenReadback(openMethod, options, started);
  if (readback.refusal !== null) {
    client.kill();
    await client.exited;
    throw new Error(readback.refusal);
  }
  const kernel = credentials.kernel(threadId);
  const state: CodexSessionState = {
    active: null,
    spontaneous: false,
    codexTurnId: null,
    // A resume awaits codex's re-report of the thread's total so far: the
    // baseline this Session's token totals count from (projection.ts, #169).
    projection: initialCodexProjection(threadId, openMethod),
  };
  const busy = (): boolean => state.active !== null || state.spontaneous;
  const abortFallback = createAbortFallback(() => { client.kill(); });
  let disposeRequest: RequestRecord | null = null;
  // A resume's effort update in flight: codex's thread/settings/updated answers it.
  let settingsWaiter: ((params: JsonRecord) => void) | null = null;

  recordOpen = (): void => {
    kernel.frame({ type: openMethod, native: started, events: readback.events });
  };
  // Drive the pure projection fold, applying its commands to the kernel; the
  // fold owns event translation, attribution and graph links; this owns the
  // transport-only turn id and the control decisions (busy, spontaneous).
  const onNotification = (method: string, params: JsonRecord): void => {
    const isRoot = typeof params.threadId !== "string" || params.threadId === threadId;
    if (isRoot && method === "turn/started") {
      const startedTurn = asRecord(params.turn)?.id;
      if (!busy()) {
        // A turn we did not prompt (a drained queue submission): adopt it.
        state.spontaneous = true;
      }
      if (typeof startedTurn === "string") {
        state.codexTurnId = startedTurn;
      }
    }
    const { state: nextProjection, commands } = foldCodexNotification(state.projection, method, params);
    state.projection = nextProjection;
    for (const command of commands) {
      switch (command.kind) {
        case "frame":
          if (command.sessionId !== undefined) {
            kernel.node(command.sessionId);
          }
          kernel.frame(command.body, {
            ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
            ...(command.spanId === undefined ? {} : { spanId: command.spanId }),
          });
          break;
        case "link":
          kernel.link(command.edge);
          break;
        default:
          break;
      }
    }
    if (isRoot && method === "turn/completed") {
      abortFallback.clear();
      state.active = null;
      state.spontaneous = false;
      state.codexTurnId = null;
    }
    if (isRoot && method === "thread/settings/updated") {
      settingsWaiter?.(params);
    }
  };
  // Approvals, user input, dynamic tools: recorded verbatim, never answered
  // (approvalPolicy never means none are expected; a dangling request is
  // the honest record when one arrives anyway).
  const onServerRequest = (id: string, method: string, params: JsonRecord): void => {
    kernel.request("toApp", { kind: "native", type: method, native: params }, { id });
  };
  // Registering flushes everything held so far in wire order: the frames
  // from before the thread existed, then the open event (the mark placed at
  // the reply), then whatever codex wrote after the reply.
  client.handle({ onNotification, onServerRequest });
  client.onExit((code) => {
    abortFallback.clear();
    // The exit is an outcome only oar observes: it answers our dispose when
    // we caused it, and stands alone when the app-server died on its own.
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
    state.active = null;
    state.spontaneous = false;
    state.codexTurnId = null;
  });
  if (readback.resumeEffort !== null) {
    // The resumed thread runs another level: set it on the loaded thread and
    // take codex's pushed settings (a recorded frame) as the word on it.
    const requested = readback.resumeEffort;
    const { promise: reported, resolve } = Promise.withResolvers<JsonRecord | null>();
    settingsWaiter = resolve;
    const timer = setTimeout(() => {
      resolve(null);
    }, CODEX_SETTINGS_REPORT_MS);
    const update = await client.request("thread/settings/update", { threadId, effort: requested })
      .then(() => null, (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    const refusal = codexResumeEffortRefusal(requested, update, update === null ? await reported : null);
    clearTimeout(timer);
    settingsWaiter = null;
    if (refusal !== null) {
      client.kill();
      await client.exited;
      throw new Error(refusal);
    }
  }

  /** Turn a plan builder into a Session control member. */
  const via = <Args extends unknown[]>(plan: (...args: Args) => RpcControlPlan) =>
    async (...args: Args): Promise<ControlResult> => {
      const result = await rpcControl(kernel, client, plan(...args));
      return result;
    };
  const capabilities = { queue: { durable: true }, attribution: "nested", images: true } as const;
  const promptPlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => ({
    body: { kind: "prompt", input, ...inputOptions },
    gate: (request) => {
      const refused = busy() ? { kind: "rejected", code: "busy", reason: "busy" } as const : inputImagesRefusal(capabilities, inputOptions?.images);
      if (refused !== null) {
        return refused;
      }
      // Hold the slot while the RPC is in flight so a concurrent prompt is busy.
      state.active = request;
      return null;
    },
    method: "turn/start",
    params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId }),
    onReply: (reply) => {
      const turnId = asRecord(reply.turn)?.id;
      if (typeof turnId !== "string") {
        state.active = null;
        return { kind: "rejected", code: "runtime_refused", reason: "codex turn/start returned no turn id", native: reply };
      }
      state.codexTurnId = turnId;
      return { kind: "accepted", native: reply };
    },
    onError: (message) => {
      state.active = null;
      return { kind: "rejected", code: "runtime_refused", reason: message };
    },
  });
  const steerPlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => {
    const expectedTurnId = state.codexTurnId;
    return {
      body: { kind: "steer", input, ...inputOptions },
      gate: () => (!busy() || expectedTurnId === null ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" } : inputImagesRefusal(capabilities, inputOptions?.images)),
      method: "turn/steer",
      params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), expectedTurnId, clientUserMessageId: inputOptions?.inputId }),
      onReply: (reply) => {
        if (expectedTurnId !== null && inputOptions?.inputId !== undefined) {
          state.projection = { ...state.projection, inputs: acceptCodexSteer(state.projection.inputs, expectedTurnId, inputOptions.inputId) };
        }
        return { kind: "accepted", native: reply };
      },
      onError: (message) => ({ kind: "rejected", code: "runtime_refused", reason: `not_steerable: ${message}` }),
    };
  };
  // The reply carries the runtime's submission id; it is retained on the response.
  const queuePlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => ({
    body: { kind: "queue", input, ...inputOptions },
    gate: () => inputImagesRefusal(capabilities, inputOptions?.images),
    method: "thread/queue/add",
    params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId ?? randomUUID() }),
    onReply: (reply) => ({ kind: "accepted", native: reply }),
    onError: (message) => ({ kind: "rejected", code: "runtime_refused", reason: message }),
  });
  // An early or late interrupt can be refused; turn/completed is the outcome.
  const abortPlan = (): RpcControlPlan => {
    let refused: (() => void) | null = null;
    return {
      body: { kind: "abort" },
      gate: () => {
        if (!busy() || state.codexTurnId === null) {
          return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
        }
        return null;
      },
      onPending: (accept) => { refused = abortFallback.arm(accept); },
      method: "turn/interrupt",
      params: () => ({ threadId, turnId: state.codexTurnId }),
      onReply: (reply) => ({ kind: "accepted", native: reply }),
      onError: (message) => {
        refused?.();
        return { kind: "rejected", code: "runtime_refused", reason: message };
      },
    };
  };
  const session: Session = credentials.seal({
    id: kernel.sessionId,
    capabilities,
    prompt: via(promptPlan),
    steer: via(steerPlan),
    queue: via(queuePlan),
    // No withdraw: the queue is codex's own, and thread/queue/delete is experimental and not live-verified (docs/runtimes/input-cancellation.md).
    abort: via(abortPlan),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    resources: client.resources,
    dispose: async () => {
      if (disposeRequest !== null) {
        return;
      }
      const gone = kernel.unreachable() !== null; // only an observed exit can say so before this dispose is recorded
      disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
      if (gone) {
        // The exit is already recorded; nothing is left to release.
        kernel.respond(disposeRequest.id, { kind: "accepted" });
        return;
      }
      client.kill();
      // Await the actual exit: the process may hold state (codex's sqlite
      // runtime in CODEX_HOME) that the next session needs released. The
      // exit response is recorded by onExit.
      await client.exited;
    },
  });
  return session;
});
