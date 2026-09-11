import { randomUUID } from "node:crypto";
import type {
  ControlResult,
  RequestRecord,
  Session,
  StartSession,
} from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { startAppServerClient, type RpcOutcome } from "./app-server-client.js";
import {
  foldCodexNotification,
  initialCodexProjection,
  type CodexProjectionState,
} from "./projection.js";
import { openThread, rpcControl, type RpcControlPlan } from "./rpc-control.js";

/*
 * codex app-server v2 mapping:
 * - initialize → initialized, thread/start {cwd, approvalPolicy:never}
 * - turn/start {threadId, input} → {turn{id}}: the RPC reply is the prompt's
 *   accepted response; completion is codex's own turn/completed notification
 *   (turn.status completed | interrupted | failed) — the turn_ended view.
 * - steer: turn/steer with the expectedTurnId precondition (race adjudicated
 *   at the runtime); a typed refusal is a rejected response.
 * - abort: turn/interrupt {threadId, turnId}; the reply is the abort's
 *   accepted/rejected response, the outcome is turn/completed.
 * - every notification is one event record (verbatim params); notifications
 *   of other threads are child-session records; collab items link them.
 * - server-initiated requests are recorded as toApp requests, unanswered.
 * - reachability (exited / disposed) is the kernel's, read off the stream;
 *   the adapter holds no liveness flag (record-stream.md, "Reachability").
 * Live probe: codex-session-adapter.ts.
 */

const text = (input: string): { type: "text"; text: string }[] => [{ type: "text", text: input }];

interface CodexSessionState {
  /** The prompt request whose turn is running; null while idle or during a spontaneous turn. */
  active: RequestRecord | null;
  /** True while codex runs a root turn we did not prompt (a drained queue submission). */
  spontaneous: boolean;
  /** The runtime's id for the active root turn — steer/abort identity. */
  codexTurnId: string | null;
  projection: CodexProjectionState;
}

export const codexSession: StartSession = async (installation, options) => {
  if (installation.via !== "executable") {
    throw new Error("The codex session adapter needs an executable installation");
  }
  // YOLO default (repo policy 2026-08-24): bypass the sandbox too, not just
  // approvals — OAR_CODEX_SANDBOX pins a stricter mode when a host wants one.
  // Injected as a launch -c override because that is the only seam that
  // governs codex's exec tool; thread/start.sandboxMode does NOT (pinned on a
  // real login). A host that wants the user's own config to win can set
  // OAR_CODEX_SANDBOX=inherit to skip the override entirely.
  const sandboxMode = process.env.OAR_CODEX_SANDBOX ?? "danger-full-access";
  const configOverrides = sandboxMode === "inherit" ? {} : { sandbox_mode: `"${sandboxMode}"` };
  const client = startAppServerClient(installation.command, options.env, configOverrides);
  await client.request("initialize", {
    clientInfo: { name: "oar", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  // Threads persist so a later SessionOptions.resume can reattach; the thread
  // id is the runtime-native identity and becomes Session.id.
  // System prompt seams (probed 2026-08-24 via the aimock journal):
  // baseInstructions REPLACES codex's base prompt; developerInstructions
  // APPENDS as a developer message. "instructions"/"userInstructions" are
  // silently ignored by thread/start.
  const instructionParams = {
    ...(options.systemPrompt === undefined ? {} : { baseInstructions: options.systemPrompt }),
    ...(options.appendSystemPrompt === undefined ? {} : { developerInstructions: options.appendSystemPrompt }),
  };
  const openMethod = options.resume === undefined ? "thread/start" : "thread/resume";
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
    const reply = await (options.resume === undefined
    ? client.request("thread/start", {
        cwd: options.cwd,
        ...(options.model === undefined ? {} : { model: options.model }),
        approvalPolicy: "never",
        // Required in addition to initialize.experimentalApi. This exposes
        // the completed Responses API reasoning item, whose encrypted_content
        // lets us distinguish redaction from genuinely empty reasoning.
        experimentalRawEvents: true,
        ...instructionParams,
      }, markOpen)
    : client.request("thread/resume", {
        threadId: options.resume,
        excludeTurns: true,
        cwd: options.cwd,
        // Same-runtime model switch = resume the same thread id with a new
        // model. thread/resume accepts `model` (codex rust-v0.153.4,
        // protocol/v2/thread.rs ThreadResumeParams) and applies it when the
        // thread is loaded cold, which is the normal case here because every
        // oar session owns its own app-server process.
        ...(options.model === undefined ? {} : { model: options.model }),
        approvalPolicy: "never",
        ...instructionParams,
      }, markOpen));
    return reply;
  });
  const threadId = asRecord(started.thread)?.id;
  if (typeof threadId !== "string") {
    client.kill();
    throw new TypeError("codex thread start/resume returned no thread id");
  }
  // Both responses report the model actually active (Session.model() reads
  // it back as a model view on the open event). Still check it against the
  // request: codex's resume_running_thread ignores overrides for a thread
  // that is already loaded and busy (warn "thread/resume overrides ignored
  // for loaded thread") and answers with the old model; a caller who asked
  // for a model must not get one silently running another.
  const effectiveModel = typeof started.model === "string" ? started.model : null;
  if (options.model !== undefined && effectiveModel !== null && effectiveModel !== options.model) {
    client.kill();
    throw new Error(`codex ${openMethod} kept model ${effectiveModel} although ${options.model} was requested`);
  }

  const kernel = createSessionKernel(threadId);
  const state: CodexSessionState = {
    active: null,
    spontaneous: false,
    codexTurnId: null,
    projection: initialCodexProjection(threadId),
  };
  const busy = (): boolean => state.active !== null || state.spontaneous;
  let disposeRequest: RequestRecord | null = null;

  recordOpen = (): void => {
    kernel.event({
      type: openMethod,
      native: started,
      views: effectiveModel === null ? [] : [{ kind: "model", model: effectiveModel }],
    });
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
        case "event":
          if (command.sessionId !== undefined) {
            kernel.node(command.sessionId);
          }
          kernel.event(command.body, {
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
      state.active = null;
      state.spontaneous = false;
      state.codexTurnId = null;
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
    // The exit is an outcome only oar observes: it answers our dispose when
    // we caused it, and stands alone when the app-server died on its own.
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
    state.active = null;
    state.spontaneous = false;
    state.codexTurnId = null;
  });

  /** Turn a plan builder into a Session control member. */
  const via = <Args extends unknown[]>(plan: (...args: Args) => RpcControlPlan) =>
    async (...args: Args): Promise<ControlResult> => {
      const result = await rpcControl(kernel, client, plan(...args));
      return result;
    };
  const promptPlan = (input: string): RpcControlPlan => ({
    body: { kind: "prompt", input },
    gate: (request) => {
      if (busy()) {
        return { kind: "rejected", reason: "busy" };
      }
      // Hold the slot while the RPC is in flight so a concurrent prompt is busy.
      state.active = request;
      return null;
    },
    method: "turn/start",
    params: () => ({ threadId, input: text(input) }),
    onReply: (reply) => {
      const turnId = asRecord(reply.turn)?.id;
      if (typeof turnId !== "string") {
        state.active = null;
        return { kind: "rejected", reason: "codex turn/start returned no turn id", native: reply };
      }
      state.codexTurnId = turnId;
      return { kind: "accepted", native: reply };
    },
    onError: (message) => {
      state.active = null;
      return { kind: "rejected", reason: message };
    },
  });
  const steerPlan = (input: string): RpcControlPlan => ({
    body: { kind: "steer", input },
    gate: () => (!busy() || state.codexTurnId === null ? { kind: "rejected", reason: "not_steerable: no active turn" } : null),
    method: "turn/steer",
    params: () => ({ threadId, input: text(input), expectedTurnId: state.codexTurnId }),
    onReply: (reply) => ({ kind: "accepted", native: reply }),
    onError: (message) => ({ kind: "rejected", reason: `not_steerable: ${message}` }),
  });
  // The reply carries the runtime's submission id; it is retained on the response.
  const queuePlan = (input: string): RpcControlPlan => ({
    body: { kind: "queue", input },
    gate: () => null,
    method: "thread/queue/add",
    params: () => ({ threadId, input: text(input), clientUserMessageId: randomUUID() }),
    onReply: (reply) => ({ kind: "accepted", native: reply }),
    onError: (message) => ({ kind: "rejected", reason: message }),
  });
  // A refused interrupt is the contractual late abort: the turn ended before
  // it landed, and turn/completed carries the real outcome.
  const abortPlan = (): RpcControlPlan => ({
    body: { kind: "abort" },
    gate: () => (!busy() || state.codexTurnId === null ? { kind: "rejected", reason: "no active turn" } : null),
    method: "turn/interrupt",
    params: () => ({ threadId, turnId: state.codexTurnId }),
    onReply: (reply) => ({ kind: "accepted", native: reply }),
    onError: (message) => ({ kind: "rejected", reason: message }),
  });

  const session: Session = sealSession({
    id: kernel.sessionId,
    capabilities: { steer: true, queue: { durable: true }, attribution: "nested" },
    prompt: via(promptPlan),
    steer: via(steerPlan),
    queue: via(queuePlan),
    abort: via(abortPlan),
    subscribe: (observer, cursor) => kernel.subscribe(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
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
};
