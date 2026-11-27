import { sessionFileLocator } from "../../shared/native-session-file.js";
import { codexTaskControl } from "./task-control.js";
import { manualCompaction } from "../../shared/manual-compaction.js";
import { codexCompaction, codexCompactionBusy } from "./compaction.js";
import { appendCleanupFailure } from "../../shared/executable/process-cleanup.js";
import { codexGoalControl, confirmCodexGoals } from "./goal.js";
/* oxlint-disable import/max-dependencies -- The adapter composes protocol, input and process-lifetime mechanisms. */
import { randomUUID } from "node:crypto";
import type { ControlResult, InputOptions, PromptOptions, RequestRecord, Session, StartSession } from "../../contracts/session.js";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { acceptCodexSteer, codexUserInput, codexQueueRefusal } from "./input-delivery.js";
import { inputImagesRefusal } from "../../shared/input-images.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { newSessionLinks } from "../../shared/session-links.js";
import { startAppServerClient, type RpcOutcome } from "./app-server-client.js";
import { createCodexEphemeralQueue, type CodexEphemeralQueue } from "./ephemeral-queue.js";
import { CODEX_SETTINGS_REPORT_MS, codexLaunchSandboxMode, codexOpenReadback, codexResumeEffortRefusal, codexThreadName, codexThreadOpen } from "./open.js";
import { codexEphemeralVersionRefusal } from "./options.js";
import { foldCodexNotification, initialCodexProjection, type CodexProjectionState } from "./projection.js";
import { prepareCodexOpenParams } from "./open-config.js";
import { missingDirectoryError, nameThread, openThread, rpcControl, updateThreadEffort, type RpcControlPlan } from "./rpc-control.js";
import { codexControlRefusal, codexVersion } from "./refusal.js";
import { codexServerRequests } from "./runtime-requests.js";
import { createUserQuestions } from "../../shared/user-questions.js";
import { CODEX_QUESTION_CONFIG, codexQuestionWithdrawn, codexUserQuestionRefusal, createCodexSecretQuestions } from "./user-questions.js";
import { codexTurnProcesses, refuseSharedTurnProcesses } from "./turn-processes.js";
/* App-server v2: RPC replies answer controls synchronously before later notifications. Model/effort read-back: open.ts.
 * Reachability: recorded exit/dispose. Native mappings: docs/runtimes/codex.md. */
interface CodexSessionState {
  /** The prompt request whose turn is running; null while idle or during a spontaneous turn. */
  active: RequestRecord | null;
  /** True while codex runs a root turn we did not prompt (a drained queue submission). */
  spontaneous: boolean;
  /** The runtime's id for the active root turn; steer/abort identity. */
  codexTurnId: string | null;
  /** Native interrupted completion pauses queue dispatch until another root turn starts. */
  queuePausedAfterInterrupt: boolean;
  projection: CodexProjectionState;
}
export const codexSession: StartSession = withSessionCredentials(async (installation, options, credentials, context) => {
  if (installation.via !== "executable") { throw new Error("The codex session adapter needs an executable installation"); }
  refuseSharedTurnProcesses(options, context);
  refuseSessionOptions({ ...codexUserQuestionRefusal(installation.version), ...codexEphemeralVersionRefusal(installation.version) }, options);
  const sandboxMode = codexLaunchSandboxMode(options);
  const { method: openMethod, params: openParams, redact } = codexThreadOpen(options, sandboxMode);
  const configOverrides = { ...(sandboxMode === "inherit" ? {} : { sandbox_mode: `"${sandboxMode}"` }), ...(options.goals === true ? { "features.goals": "true" } : {}), ...(options.userQuestions === "host" ? CODEX_QUESTION_CONFIG : {}) };
  const client = startAppServerClient(installation.command, options.env, configOverrides, options.cwd, { redact, ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }) });
  const cleanup: { reason?: string } = {};
  client.onExit((_code, reason) => { if (reason !== undefined) { cleanup.reason = reason; } });
  try {
    const version = codexVersion(await client.request("initialize", {
      clientInfo: { name: "oar", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    })) ?? installation.version ?? null;
    client.notify("initialized", {});
    if (options.goals === true) { await confirmCodexGoals(client); }
    const effectiveOpenParams = await prepareCodexOpenParams(client, options, openParams);
    // Mark the open event at the reply's wire position so same-chunk frames stay ordered.
    let recordOpen: (() => void) | null = null;
    const markOpen = (outcome: RpcOutcome): void => {
      if (outcome.kind === "result") { client.mark(() => recordOpen?.()); }
    };
    const started = await openThread(openMethod, async () => {
      const reply = await client.request(openMethod, effectiveOpenParams, markOpen);
      return reply;
    }, { version, serviceTier: options.serviceTier, resumeId: options.resume, through: options.fork?.through, ephemeral: options.ephemeral });
    const threadId = asRecord(started.thread)?.id;
    if (typeof threadId !== "string") { throw new TypeError("codex thread/start, thread/resume or thread/fork returned no thread id"); }
    const readback = codexOpenReadback(openMethod, options, started);
    if (readback.refusal !== null) { throw typeof readback.refusal === "string" ? new Error(readback.refusal) : readback.refusal; }
    const kernel = credentials.kernel(threadId);
    const state: CodexSessionState = {
      active: null,
      spontaneous: false,
      codexTurnId: null,
      queuePausedAfterInterrupt: false,
      projection: initialCodexProjection(threadId, openMethod),
    };
    const questions = options.userQuestions === "host" ? createUserQuestions(kernel) : undefined;
    const secretQuestions = options.userQuestions === "host" ? createCodexSecretQuestions(credentials.add) : undefined;
    const tasks = codexTaskControl(kernel, client, () => state.projection.subagents);
    const nativeBusy = (): boolean => state.active !== null || state.spontaneous;
    let ephemeralQueue: CodexEphemeralQueue | null = null;
    let compactOperation: ReturnType<typeof codexCompaction> | null = null;
    const compaction = manualCompaction(kernel, {
      busy: options.ephemeral === true ? (): boolean => nativeBusy() || ephemeralQueue?.hasHeld() === true : codexCompactionBusy(kernel, nativeBusy),
      busyReason: "Codex manual compaction requires an idle session without an active goal or queued input",
      create: () => { compactOperation = codexCompaction(client, threadId); return compactOperation; },
      ...(options.ephemeral === true ? { released: (): void => { ephemeralQueue?.drain(); } } : {}),
    });
    const busy = (): boolean => nativeBusy() || compaction.busy();
    const abortFallback = createAbortFallback(() => { client.kill(); });
    const turnProcesses = codexTurnProcesses(options, kernel, client);
    // A resume's effort update in flight: codex's thread/settings/updated answers it.
    let settingsWaiter: ((params: JsonRecord) => void) | null = null;
    recordOpen = (): void => { kernel.frame({ type: openMethod, native: started, events: readback.events }); };
    // Drive the pure projection fold, applying its commands to the kernel; the
    // fold owns event translation, attribution and graph links; this owns the
    // transport-only turn id and the control decisions (busy, spontaneous).
    const onNotification = (method: string, params: JsonRecord): void => {
      tasks.observe(method, params);
      const isRoot = typeof params.threadId !== "string" || params.threadId === threadId;
      if (isRoot && method === "turn/started") {
        state.queuePausedAfterInterrupt = false;
        const startedTurn = asRecord(params.turn)?.id;
        if (!busy()) {
          // A turn we did not prompt (a drained queue submission): adopt it.
          state.spontaneous = true;
        }
        if (typeof startedTurn === "string") {
          state.codexTurnId = startedTurn;
        }
      }
      if (isRoot && method === "turn/completed") {
        state.queuePausedAfterInterrupt = asRecord(params.turn)?.status === "interrupted";
        abortFallback.clear();
        state.active = null;
        state.spontaneous = false;
        state.codexTurnId = null;
      }
      const scrubbedParams = secretQuestions === undefined ? params : secretQuestions.scrubNotification(method, params);
      const { state: nextProjection, commands } = foldCodexNotification(state.projection, method, scrubbedParams);
      state.projection = nextProjection;
      const withdrawn = codexQuestionWithdrawn(questions, method, scrubbedParams);
      const links = newSessionLinks(kernel, commands.flatMap((command) => command.kind === "link" ? [command.edge] : []));
      for (const command of commands) {
        switch (command.kind) {
          case "frame":
            kernel.frame({ ...command.body, events: [...command.body.events, ...withdrawn, ...links] }, {
              ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
              ...(command.spanId === undefined ? {} : { spanId: command.spanId }),
            });
            break;
          case "link":
            break;
          default:
            break;
        }
      }
      if (isRoot && method === "turn/completed") { turnProcesses.turnCompleted(params); ephemeralQueue?.drain(); }
      if (isRoot && method === "thread/settings/updated") { settingsWaiter?.(params); }
    };
    const onServerRequest = codexServerRequests(kernel, client, questions, secretQuestions);
    // Registering flushes held frames in wire order around the open mark.
    client.handle({ onNotification, onServerRequest });
    client.onExit((code, reason) => {
      abortFallback.clear(); secretQuestions?.clear(); ephemeralQueue?.clear();
      turnProcesses.exited();
      // The exit is an outcome only oar observes: it answers our dispose when
      // we caused it, and stands alone when the app-server died on its own.
      kernel.processExited(code, reason);
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
      let refusal: string | null = null;
      try {
        const update = await updateThreadEffort(client, threadId, requested, version);
        refusal = codexResumeEffortRefusal(requested, update, update === null ? await reported : null);
      } finally { clearTimeout(timer); settingsWaiter = null; }
      if (refusal !== null) { throw new Error(refusal); }
    }
    await nameThread(client, threadId, codexThreadName(openMethod, options, started), (native) => { kernel.frame({ type: "thread/name/set/error", native, events: [] }); });
    /** Turn a plan builder into a Session control member. */
    const via = <Args extends unknown[]>(plan: (...args: Args) => RpcControlPlan) => async (...args: Args): Promise<ControlResult> => { const result = await rpcControl(kernel, client, plan(...args)); return result; };
    const capabilities = { queue: { durable: options.ephemeral !== true }, attribution: "nested", images: true } as const;
    const promptPlan = (input: string, inputOptions?: PromptOptions, internal?: { readonly allowHeld?: boolean; readonly wireInputId?: string | undefined }): RpcControlPlan => ({
      body: { kind: "prompt", input, ...inputOptions },
      gate: (request) => {
        const refused = busy() || (internal?.allowHeld !== true && ephemeralQueue?.hasHeld() === true)
          ? { kind: "rejected", code: "busy", reason: "busy" } as const
          : inputImagesRefusal(capabilities, inputOptions?.images);
        if (refused !== null) { return refused; }
        state.active = request;
        return null;
      },
      method: "turn/start",
      params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), clientUserMessageId: internal?.wireInputId ?? inputOptions?.inputId, ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }) }),
      onReply: (reply) => {
        const turnId = asRecord(reply.turn)?.id;
        if (typeof turnId !== "string") {
          state.active = null;
          return { kind: "rejected", code: "runtime_refused", reason: "codex turn/start returned no turn id", native: reply };
        }
        state.codexTurnId = turnId;
        return { kind: "accepted", native: reply };
      },
      onError: (message, native) => {
        state.active = null;
        return codexControlRefusal(message, native);
      },
    });
    const promptDispatch = via(turnProcesses.prompting(promptPlan));
    ephemeralQueue = options.ephemeral === true
      ? createCodexEphemeralQueue({ kernel, capabilities, busy, dispatch: async (input, promptOptions, wireInputId) => { const result = await promptDispatch(input, promptOptions, { allowHeld: true, wireInputId }); return result; } })
      : null;
    const steerPlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => {
      const expectedTurnId = state.codexTurnId;
      return {
        body: { kind: "steer", input, ...inputOptions },
        gate: () => compaction.busy() ? { kind: "rejected", code: "busy", reason: "Manual compaction is still in progress" } : (!busy() || expectedTurnId === null ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" } : inputImagesRefusal(capabilities, inputOptions?.images)),
        method: "turn/steer",
        params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), expectedTurnId, clientUserMessageId: inputOptions?.inputId }),
        onReply: (reply) => {
          if (expectedTurnId !== null && inputOptions?.inputId !== undefined) {
            state.projection = { ...state.projection, inputs: acceptCodexSteer(state.projection.inputs, expectedTurnId, inputOptions.inputId) };
          }
          return { kind: "accepted", native: reply };
        },
        onError: (message, native) => codexControlRefusal(`not_steerable: ${message}`, native),
      };
    };
    const queuePlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => ({
      body: { kind: "queue", input, ...inputOptions },
      gate: () => codexQueueRefusal({ compacting: compaction.busy(), interrupted: state.queuePausedAfterInterrupt, hasSchema: options.outputSchema !== undefined, images: inputOptions?.images }),
      method: "thread/queue/add",
      params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId ?? randomUUID() }),
      onReply: (reply) => ({ kind: "accepted", native: reply }),
      onError: (message, native) => codexControlRefusal(message, native),
    });
    // An early or late interrupt can be refused; turn/completed is the outcome.
    const abortPlan = (): RpcControlPlan => {
      let refused: (() => void) | null = null;
      const turnId = compaction.busy() ? compactOperation?.turnId() ?? null : state.codexTurnId;
      return {
        body: { kind: "abort" },
        gate: () => {
          if (compaction.busy() && turnId === null) {
            return { kind: "rejected", code: "busy", reason: "Codex has not yet reported the compaction turn id required by turn/interrupt" };
          }
          if (!busy() || turnId === null) {
            return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
          }
          return null;
        },
        onPending: (accept) => { refused = abortFallback.arm(accept); },
        method: "turn/interrupt",
        params: () => ({ threadId, turnId }),
        onReply: (reply) => ({ kind: "accepted", native: reply }),
        onError: (message, native) => {
          refused?.();
          return codexControlRefusal(message, native);
        },
      };
    };
    const sessionFile = asRecord(started.thread)?.path;
    const session: Session = credentials.seal({
      ...(typeof sessionFile === "string" ? { nativeSessionFile: sessionFileLocator(sessionFile, credentials.redact) } : {}),
      id: kernel.sessionId,
      ...(options.goals === true ? { goal: codexGoalControl(kernel, client, threadId) } : {}),
      capabilities,
      compact: compaction.compact,
      prompt: async (input, inputOptions) => { const result = await promptDispatch(input, inputOptions); return result; },
      steer: via(steerPlan),
      queue: ephemeralQueue === null ? via(queuePlan) : ephemeralQueue.queue,
      ...(ephemeralQueue === null ? {} : { withdraw: ephemeralQueue.withdraw }),
      abort: via(turnProcesses.aborting(abortPlan)),
      stopTask: tasks.stop,
      ...(questions === undefined ? {} : { answerQuestion: questions.answer }),
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      resources: client.resources,
      dispose: async () => {
        await kernel.dispose(async () => {
          ephemeralQueue?.clear();
          // Idle app-server exits on stdin EOF; active turns stop immediately and await exit so codex releases CODEX_HOME sqlite locks.
          if (!busy() && client.close !== undefined) {
            await client.close();
          } else {
            client.kill();
            await client.exited;
          }
          await turnProcesses.settled();
        });
        secretQuestions?.clear();
      },
    });
    return session;
  } catch (error) {
    // No Session can dispose a failed open; wait for its process before rejecting.
    client.kill();
    await client.exited;
    throw appendCleanupFailure(missingDirectoryError(error, options.cwd), cleanup.reason);
  }
});
