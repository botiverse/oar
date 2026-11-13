// BYOK change: Modified from OAR 95c6547 for injected processes, native-first recording, bounded request refusal, caller-selected sandbox, caller-owned open steps and session credential redaction without sealSession (Apache-2.0).
import { codexTaskControl } from "./task-control.js";
import { manualCompaction } from "../../shared/manual-compaction.js";
import { codexCompaction, codexCompactionBusy } from "./compaction.js";
/* oxlint-disable import/max-dependencies -- The adapter composes protocol, input and process-lifetime mechanisms. */
import type { AvailableInstallation } from "../../contracts/installation.js"; // BYOK change: direct type-only contract import.
import { randomUUID } from "node:crypto";
import type {
  ControlResult,
  InputOptions,
  RequestRecord,
  AdapterSession,
  SessionOptions,
} from "../../contracts/session.js";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { acceptCodexSteer, codexUserInput } from "./input-delivery.js";
import { inputImagesRefusal } from "../../shared/input-images.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
// BYOK change: Return the raw adapter contract without best-effort observer projections.
// BYOK change: Build the session credential redactor directly; upstream withSessionCredentials imports sealSession.
import { sessionCredentialRedactor, type CredentialRedactor } from "../../shared/credential-redactor.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import { newSessionLinks } from "../../shared/session-links.js";
import { startAppServerClient, type RpcOutcome, type SpawnLineProcess } from "./app-server-client.js";
import { CODEX_SETTINGS_REPORT_MS, codexOpenReadback, codexResumeEffortRefusal, codexThreadName, codexThreadOpen } from "./open.js";
import { foldCodexNotification, initialCodexProjection, type CodexProjectionState } from "./projection.js";
import { prepareCodexToolDenials } from "./tool-denials.js";
import { missingDirectoryError, nameThread, openThread, rpcControl, updateThreadEffort, type RpcControlPlan } from "./rpc-control.js";
import { codexControlRefusal, codexVersion } from "./refusal.js";

/*
 * App-server v2: RPC replies answer controls; notifications carry facts.
 * Record replies synchronously, before later notifications in the same chunk.
 * Model/effort read-back and resume overrides live in open.ts. Reachability
 * comes from the recorded exit/dispose, never a separate liveness flag.
 * Native mappings and live evidence: docs/runtimes/codex.md.
 * BYOK change: server requests go to an explicit caller-owned native interaction handler, or are declined/rejected immediately when absent.
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

// BYOK change: Codex implements steer even though the generic 0.18.0 adapter contract makes it optional.
export interface CodexAdapterSession extends AdapterSession {
  steer(input: string, options?: InputOptions): Promise<ControlResult>;
}

// BYOK change: No production spawn implementation or convenience Session layer is imported here.
export async function codexSession(
  spawnLineProcess: SpawnLineProcess,
  installation: AvailableInstallation,
  // BYOK change: the caller passes the complete filtered environment, so a value is never a null removal.
  options: Omit<SessionOptions, "env" | "goals" | "endTurnProcessesOnAbort"> & {
    readonly env?: Readonly<Record<string, string>>;
    readonly approvalPolicy?: "never" | "on-request"; // BYOK change: explicit local interactive opt-in.
    // BYOK change: the caller passes OAR_CODEX_SANDBOX semantics explicitly.
    readonly sandboxMode?: "read-only" | "workspace-write" | "danger-full-access" | "inherit";
  },
  serverRequestTimeoutMs = 1_000,
  hooks: { // BYOK change: the record consumer is registered before any record is appended.
    readonly onReady?: (threadId: string) => void;
    readonly onRecord?: (record: import("../../contracts/session.js").RawEvent) => void;
    // BYOK change: caller-owned, bounded native request lifecycle; no permissive fallback.
    readonly onServerRequest?: (id: string | number, method: string, params: JsonRecord, reply: {
      respond(value: JsonRecord): Promise<void>; reject(code: number, message: string): Promise<void>; cancelled(): void;
    }) => void;
    // BYOK change: caller-owned steps on this app-server client, before the thread open request and after its read-back.
    readonly beforeOpen?: (request: CodexOpenStepRequest, params: JsonRecord) => Promise<JsonRecord>;
    readonly afterOpen?: (request: CodexOpenStepRequest, threadId: string) => Promise<void>;
  } = {},
): Promise<CodexAdapterSession> {
  // BYOK change: Upstream withSessionCredentials without sealSession. One redactor per open keeps
  // opening failures, retained records and later control errors under the same credential rules.
  const credentials = sessionCredentialRedactor(options);
  try { return await openCodexSession(spawnLineProcess, installation, options, serverRequestTimeoutMs, hooks, credentials.redactValue); }
  catch (error) { throw credentials.redactValue(error); }
}

type CodexSessionArgs = Parameters<typeof codexSession>;
// BYOK change: one request on the session's own client, for the caller-owned open steps.
export type CodexOpenStepRequest = (method: string, params: JsonRecord) => Promise<JsonRecord>;

async function openCodexSession(
  spawnLineProcess: SpawnLineProcess,
  installation: AvailableInstallation,
  options: CodexSessionArgs[2],
  serverRequestTimeoutMs: number,
  hooks: NonNullable<CodexSessionArgs[4]>,
  redactValue: CredentialRedactor["redactValue"],
): Promise<CodexAdapterSession> {
  if (installation.via !== "executable") {
    throw new Error("The codex session adapter needs an executable installation");
  }
  // Threads persist so a later SessionOptions.resume can reattach; the thread
  // id is the runtime-native identity and becomes Session.id (open.ts builds
  // the request, and refuses what it cannot build before anything starts).
  const { method: openMethod, params: openParams, redact } = codexThreadOpen(options);
  // BYOK change: Explicit environment and caller sandbox; ambient OAR_CODEX_SANDBOX is ignored.
  if (options.env === undefined) throw new Error("codex session requires an explicit filtered environment");
  // YOLO default (repo policy 2026-08-24): bypass the sandbox too, not just
  // approvals. Injected as a launch -c override (app-server-client.ts).
  // "inherit" skips the override, so the user's own config wins.
  const sandboxMode = options.sandboxMode ?? "danger-full-access";
  const configOverrides: Record<string, string> = sandboxMode === "inherit" ? {} : { sandbox_mode: `"${sandboxMode}"` };
  if (!Number.isFinite(serverRequestTimeoutMs) || serverRequestTimeoutMs <= 0 || serverRequestTimeoutMs > 2_147_483_647) {
    throw new Error("codex server request timeout must be positive, finite and at most 2147483647ms");
  }
  // Every error the client reports goes through the redactor first: the
  // open's config carries the session's MCP credentials to codex.
  const client = startAppServerClient(spawnLineProcess, installation.command, options.env, configOverrides, options.cwd, { redact, ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }) });
  // BYOK change: One kill per failed open, so a caller-owned hook can await its exit without a second kill.
  let killedForOpen = false;
  const killForOpen = (): void => { if (!killedForOpen) { killedForOpen = true; client.kill(); } };
  // BYOK change: Every open failure releases the caller-owned process before it is reported.
  try {
  // BYOK change: Ownership/adoption must settle before the first protocol write.
  await client.spawned;
  // The running binary's own version; the probed one when codex names none.
  const version = codexVersion(await client.request("initialize", {
    clientInfo: { name: "oar", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  })) ?? installation.version ?? null;
  client.notify("initialized", {});
  const filteredOpenParams = await prepareCodexToolDenials(client, options, openParams);
  // BYOK change: a caller-owned open step that throws releases the process, as a refused open does.
  const openStep = async <T>(step: () => Promise<T>): Promise<T> => {
    try { return await step(); } catch (error) { killForOpen(); await client.exited.catch(() => {}); throw error; }
  };
  const stepRequest: CodexOpenStepRequest = (method, params) => client.request(method, params);
  const { beforeOpen, afterOpen } = hooks;
  const requestParams = beforeOpen === undefined ? filteredOpenParams : await openStep(() => beforeOpen(stepRequest, filteredOpenParams));
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
  const started = await openThread(openMethod, async () => {
    const reply = await client.request(openMethod, requestParams, markOpen);
    return reply;
  }, { version, serviceTier: options.serviceTier, resumeId: options.resume });
  const threadId = asRecord(started.thread)?.id;
  if (typeof threadId !== "string") {
    throw new TypeError("codex thread start/resume returned no thread id");
  }
  // The reply is codex's word on the model and effort the thread runs (the
  // open frame's events); anything but what was requested refuses the open.
  // BYOK change: Never advertise an interactive policy the provider did not actually apply.
  if (options.approvalPolicy === "on-request" && started.approvalPolicy !== "on-request") {
    throw new Error("codex native interaction approval policy readback mismatch");
  }
  const readback = codexOpenReadback(openMethod, options, started);
  if (readback.refusal !== null) {
    throw new Error(readback.refusal);
  }
  if (afterOpen !== undefined) await openStep(() => afterOpen(stepRequest, threadId));

  // BYOK change: The record consumer observes from seq 0: it registers before any record is appended.
  // Observer errors are swallowed by the kernel, so the consumer fails the session itself.
  const kernel = createSessionKernel(threadId, redactValue, options.retainedBytes);
  if (hooks.onRecord !== undefined) kernel.rawEvents(hooks.onRecord);
  hooks.onReady?.(threadId);
  const state: CodexSessionState = {
    active: null,
    spontaneous: false,
    codexTurnId: null,
    // A resume awaits codex's re-report of the thread's total so far: the
    // baseline this Session's token totals count from (projection.ts, #169).
    projection: initialCodexProjection(threadId, openMethod),
  };
  const tasks = codexTaskControl(kernel, client, () => state.projection.subagents);
  const nativeBusy = (): boolean => state.active !== null || state.spontaneous;
  let compactOperation: ReturnType<typeof codexCompaction> | null = null;
  const compaction = manualCompaction(kernel, { busy: codexCompactionBusy(kernel, nativeBusy), busyReason: "Codex manual compaction requires an idle session without an active goal or queued input", create: () => { compactOperation = codexCompaction(client, threadId); return compactOperation; } });
  const busy = (): boolean => nativeBusy() || compaction.busy();
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
    // BYOK change: Retain the exact native notification before any potentially throwing fold.
    // The record envelope's sessionId puts a foreign thread in the graph (observe/graph.ts); no out-of-band node.
    const notificationSession = typeof params.threadId === "string" ? params.threadId : threadId;
    // BYOK change: Structural extra metadata distinguishes native frames even when derived events are empty.
    const nativeBody = { type: method, native: params, events: [], origin: "byok-native" } as const;
    kernel.frame(nativeBody, {
      sessionId: notificationSession,
      ...(typeof params.turnId === "string" ? { spanId: params.turnId } : {}),
    });
    try {
    tasks.observe(method, params);
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
    if (isRoot && method === "turn/completed") {
      abortFallback.clear();
      state.active = null;
      state.spontaneous = false;
      state.codexTurnId = null;
    }
    const { state: nextProjection, commands } = foldCodexNotification(state.projection, method, params);
    state.projection = nextProjection;
    const links = newSessionLinks(kernel, commands.flatMap((command) => command.kind === "link" ? [command.edge] : []));
    for (const command of commands) {
      switch (command.kind) {
        case "frame":
          kernel.frame({ ...command.body, events: [...command.body.events, ...links] }, {
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
    if (isRoot && method === "thread/settings/updated") {
      settingsWaiter?.(params);
    }
    } catch (error) {
      client.kill(); // BYOK change: A required fold failure is visible and terminates the session.
      throw error;
    }
  };
  // BYOK change: Opted-in native requests use the caller-owned lifecycle; absent opt-in keeps bounded refusal.
  const onServerRequest = (id: number | string, method: string, params: JsonRecord): void => {
    // BYOK change: Record ids follow the kernel string contract; the wire reply echoes the original id.
    const request = kernel.request("toApp", { kind: "native", type: method, native: params }, { id: `native:${typeof id}:${JSON.stringify(id)}` });
    // BYOK change: This injected owner uses NativeInteractionController for deadlines and at-most-once answers.
    if (hooks.onServerRequest !== undefined) {
      let claimed = false;
      let recorded = false;
      const claim = (): void => { if (claimed) throw new Error("codex native request already answered"); claimed = true; };
      const record = (body: import("../../contracts/session.js").ResponseBody): void => {
        if (recorded) return;
        recorded = true; kernel.respond(request.id, body);
      };
      const send = async (write: () => Promise<void>, body: import("../../contracts/session.js").ResponseBody): Promise<void> => {
        claim();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([write(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("codex native reply write deadline exceeded")), serverRequestTimeoutMs);
          })]);
          record(body);
        } catch (error) {
          record({ kind: 'rejected', code: 'error', reason: 'native reply transport failed' });
          client.kill();
          throw error;
        } finally { clearTimeout(timer); }
      };
      try {
        hooks.onServerRequest(id, method, params, {
          respond: value => send(() => client.respond(id, value), { kind: "accepted" }),
          cancelled() {
            claimed = true; record({ kind: "rejected", code: "error", reason: "native request cancelled" });
          },
          reject: (code, message) => send(() => client.rejectRequest(id, code, message), { kind: "rejected", code: "unsupported", reason: message }),
        });
      } catch (error) { client.kill(); throw error; }
      return;
    }
    let settled = false;
    const finish = (body: import("../../contracts/session.js").ResponseBody): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      kernel.respond(request.id, body);
    };
    const timer = setTimeout(() => {
      finish({ kind: "rejected", code: "error", reason: `codex ${method} response deadline exceeded` });
      client.kill();
    }, serverRequestTimeoutMs);
    const failed = (error: unknown): void => {
      finish({ kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) });
      client.kill();
    };
    try {
      const written = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval"
        ? client.respond(id, { decision: "decline" })
        : method === "item/permissions/requestApproval"
          ? client.respond(id, { permissions: {} })
          : client.rejectRequest(id, -32601, `unsupported codex server request: ${method}`);
      void written.then(() => finish({ kind: "rejected", code: "unsupported", reason: `codex ${method} declined by BYOK` }), failed);
    } catch (error) { failed(error); }

  };
  // Registering flushes everything held so far in wire order: the frames
  // from before the thread existed, then the open event (the mark placed at
  // the reply), then whatever codex wrote after the reply.
  client.handle({ onNotification, onServerRequest });
  client.onExit((code, reason) => {
    abortFallback.clear();
    // The exit is an outcome only oar observes: it answers our dispose when
    // we caused it, and stands alone when the app-server died on its own.
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code, ...(reason === undefined ? {} : { reason }) });
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
  // Last, so an open refused above leaves the user's thread unrenamed.
  await nameThread(client, threadId, codexThreadName(openMethod, options, started), (native) => { kernel.frame({ type: "thread/name/set/error", native, events: [] }); });

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
    params: () => ({ threadId, input: codexUserInput(input, inputOptions?.images), clientUserMessageId: inputOptions?.inputId, ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }) }),
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
  // The reply carries the runtime's submission id; it is retained on the response.
  const queuePlan = (input: string, inputOptions?: InputOptions): RpcControlPlan => ({
    body: { kind: "queue", input, ...inputOptions },
    gate: () => compaction.busy() ? { kind: "rejected", code: "busy", reason: "Wait for manual compaction before queuing another turn" } : (options.outputSchema === undefined ? inputImagesRefusal(capabilities, inputOptions?.images)
      : { kind: "rejected", code: "unsupported", reason: "codex queued input cannot carry outputSchema; use prompt after the current turn ends" }),
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
      onError: (message) => {
        refused?.();
        return { kind: "rejected", code: "runtime_refused", reason: message };
      },
    };
  };

  // BYOK change: The upstream credentials.seal guard without sealSession: a control's thrown error is redacted.
  // As upstream, compact also redacts its outcome: its reasons can carry native error text.
  const guard = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>, cleanResult = false) =>
    async (...args: Args): Promise<Result> => {
      try { const result = await method(...args); return cleanResult ? redactValue(result) : result; } catch (error) { throw redactValue(error); }
    };
  const session: CodexAdapterSession = { // BYOK change: raw adapter without sealSession/observe dependencies.
    id: kernel.sessionId,
    capabilities,
    compact: guard(compaction.compact, true),
    prompt: guard(via(promptPlan)),
    steer: guard(via(steerPlan)),
    queue: guard(via(queuePlan)),
    // No withdraw: the queue is codex's own, and thread/queue/delete is experimental and not live-verified (docs/runtimes/input-cancellation.md).
    abort: guard(via(abortPlan)),
    stopTask: guard(tasks.stop),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: guard(async () => {
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
    }),
  };
  return session;
  } catch (error) {
    // BYOK change: No Session can dispose a failed open; the adapter's close owns the
    // disposal receipt, so this path starts the kill without awaiting a quiescence
    // promise that a failed owned-tree disposal cannot settle.
    killForOpen();
    throw missingDirectoryError(error, options.cwd);
  }
}
