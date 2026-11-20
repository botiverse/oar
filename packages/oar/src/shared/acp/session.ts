/* oxlint-disable import/max-dependencies -- Session assembly wires the environment, process, terminal host, recorder and control machinery. */
import type { SessionCleanup } from "../../contracts/placement.js";
import { appendCleanupFailure, cleanupFailureReason } from "../executable/process-cleanup.js";
import { reportedStderr } from "../executable/reported-stderr.js";
import { sessionEnvironment } from "../environment.js";
/* oxlint-disable typescript/promise-function-async -- SDK callbacks deliberately return the SDK's native promises. */
import type { AvailableInstallation } from "../../contracts/installation.js";
import type {
  ControlResult,
  InputOptions,
  RequestBody,
  RequestRecord,
  ResponseBody,
  RuntimeEventBody,
  Session,
  SessionOptions,
  StartSession,
} from "../../contracts/session.js";
import { manualCompaction, type CompactionOperation } from "../manual-compaction.js";
import { processSessionLifecycle } from "../process-session.js";
import type { ProcessLease, PooledProcess } from "../process-pool.js";
import { withSessionCredentials, type SessionCredentials } from "../session-credentials.js";
import { createAcpClientApp } from "./client-app.js";
import {
  acpMcpOpenGuard,
  closeAcpSession,
  openAcpSession,
  type AcpSessionProfile,
  type OpenedAcpSession,
} from "./profile.js";
import type { JsonRecord } from "../json.js";
import { acpLaunchArgs } from "./launch-args.js";
import { startAcpProcess, type AcpProcess } from "./process.js";
import { AcpError, acpProcessExitedError } from "./errors.js";
import { createAcpTurns, type ActiveTurn } from "./turns.js";
import { acpTakesImages } from "./prompt.js";
import { createAcpSessionState, type AcpSessionState } from "./session-state.js";
import { acpTurnTerminals } from "./turn-terminals.js";
import { sendAcpSteerRequest } from "./steer-request.js";

export type { AcpSessionProfile } from "./profile.js";
export { createAcpSessionState, type AcpSessionState } from "./session-state.js";

/*
 * ACP mapping onto the record stream (profiles carry the vendor bits):
 * - routed `session/update` frames are event records under their native session id (explicitly owned on shared connections).
 * - listed vendor notifications are recorded verbatim except credential redaction; runtime->app requests pair with automatic `answered` responses.
 * - prompt / steer / queue / withdraw / abort / dispose are toRuntime requests; turns end on the runtime's prompt answer or observed `exited` response.
 */

export function acpSession(profile: AcpSessionProfile): StartSession {
  return withSessionCredentials(async (installation: AvailableInstallation, options: SessionOptions, credentials): Promise<Session> => {
    if (installation.via !== "executable") {
      throw new Error("ACP runtimes require an executable installation");
    }
    profile.validateOptions?.(options);
    // SessionOptions.mcpServers go out in the open request (mcp-servers.ts):
    // a list with an empty or repeated name fails before anything starts,
    // and an open that fails reports no credential they carry.
    const withoutCredentials = acpMcpOpenGuard(options.mcpServers, credentials.redact);
    const args = acpLaunchArgs(profile, options);
    const environment = sessionEnvironment(options.env);
    const initializeStartedAt = profile.acquireStartup === undefined ? undefined : performance.now();
    const releaseStartup = profile.acquireStartup === undefined ? undefined : await profile.acquireStartup(options, profile.initializeTimeoutMs ?? 60_000);
    try {
      const state = createAcpSessionState(profile, options, environment, undefined, () => runtime.pid);
      const { terminalHost, recorder, opening } = state;
      const client = createAcpClientApp(terminalHost, state.hooks);
      const runtime: AcpProcess = startAcpProcess(installation.command, args, client, { cwd: options.cwd, env: environment, redact: credentials.redact, sessionExit: "isolated", opening });
      // Process exit can precede the SDK's failed-open settlement.
      // oxlint-disable-next-line promise/prefer-await-to-then -- Observe exit independently of the opening RPC.
      if (releaseStartup !== undefined) { void runtime.exited.then(releaseStartup, releaseStartup); }
      const opened = await openAcpSession(runtime, profile, options, (step) => {
        if (step.method === "initialize") { releaseStartup?.(); }
        recorder.step(step.method, step.response);
      }, state.configUpdates, initializeStartedAt).catch(async (error: unknown) => {
        releaseStartup?.();
        runtime.kill();
        await runtime.exited;
        await terminalHost.dispose();
        const failure = error instanceof AcpError && error.kind === "process_exited"
          ? acpProcessExitedError(error.exitCode, runtime.diagnostics(), credentials.redact) : error;
        const reason = cleanupFailureReason(runtime.diagnostics().cleanup);
        throw withoutCredentials(appendCleanupFailure(failure, reason));
      });
      return finishAcpSession(profile, options, credentials, runtime, opened, state);
    } finally { releaseStartup?.(); }
  });
}

export interface SharedAcpSessionOwnership {
  readonly lease: ProcessLease<PooledProcess>;
  readonly cleanup: (request: RequestRecord) => Promise<SessionCleanup | void>;
  readonly detach: () => void;
  readonly stopRequests: () => void;
  readonly redact: <T>(value: T) => T;
}

/** One session layer, irrespective of whether its connection has peers. */
export function finishAcpSession(
  profile: AcpSessionProfile,
  options: SessionOptions,
  credentials: SessionCredentials,
  runtime: AcpProcess,
  opened: OpenedAcpSession,
  sessionState: AcpSessionState,
  shared?: SharedAcpSessionOwnership,
): Session {
  const { terminalHost, recorder, usageGate, tokenUsage, nativeTurns } = sessionState;
  const kernel = credentials.kernel(opened.sessionId, shared?.redact);

  const capabilities = { ...profile.capabilities, images: profile.capabilities.images ?? acpTakesImages(opened.initialized) };
  const ownership = shared;
  let compaction: ReturnType<typeof manualCompaction> | null = null;
  const promptUsage = (response: JsonRecord): RuntimeEventBody | null => tokenUsage.prompt(response, opened.initialized);
  const turns = createAcpTurns({ operationBusy: () => compaction?.busy() === true, kernel, runtime, profile, usageGate, capabilities, promptMeta: profile.promptMeta?.(options), promptUsage,
    ...(nativeTurns === undefined ? {} : { native: { promptParams: (inputId: string | undefined): JsonRecord => ({ _meta: nativeTurns.name(inputId) }), afterClose: nativeTurns.afterOarTurn } }),
    ...(ownership === undefined ? {} : { fallback: async (request: RequestRecord): Promise<void> => { ownership.stopRequests(); await lifecycle?.abortFallback(request); } }),
  });
  // The runtime's own turn is the active turn: prompt is busy, held input waits, steer and abort reach it.
  nativeTurns?.bind({ active: () => turns.active(), adopt: () => turns.beginOperation(null), release: (turn) => {
    const active = turns.active();
    if (active === turn) { turns.finishOperation(active); }
  } });
  // Bound only now: frames queued since the open answer may start a native turn, which needs the driver above.
  recorder.bind(kernel);
  const turnTerminals = acpTurnTerminals(options.endTurnProcessesOnAbort === true, kernel, terminalHost, () => turns.active());
  const createCompaction = profile.compaction;
  if (createCompaction !== undefined) {
    compaction = manualCompaction(kernel, {
      busy: () => turns.active() !== null || turns.queued() || turns.pendingCancellation() !== null,
      busyReason: "Wait for native input and cancellation to finish before compacting",
      settledBy: "native_response",
      released: () => { queueMicrotask(() => { turns.drain(); }); },
      create: (): CompactionOperation => {
        const operation = createCompaction(kernel, runtime, promptUsage);
        let state: ActiveTurn | null = null;
        const finish = (): void => { if (state !== null) { turns.finishOperation(state); state = null; } };
        return {
          observe(frame) {
            const result = operation.observe(frame);
            if (result !== null) { finish(); }
            return result;
          },
          async start(request, reply) {
            state = turns.beginOperation(request);
            try { return await operation.start(request, reply); }
            finally { finish(); }
          },
        };
      },
    });
  }
  const disposeTerminals = async (): Promise<void> => {
    try { await terminalHost.dispose(); }
    catch (error) { kernel.respond("", { kind: "cleanup", result: { kind: "failed", reason: error instanceof Error ? error.message : String(error) } }); }
  };
  const observedLease = ownership === undefined ? undefined : { ...ownership.lease, onExit: (listener: (code: number | null) => void): (() => void) => ownership.lease.onExit((code) => {
    listener(code); turns.onExit(); void disposeTerminals();
  }) };
  const lifecycle = observedLease === undefined || ownership === undefined ? undefined : processSessionLifecycle(kernel, observedLease, ownership.cleanup, 5000);
  // oxlint-disable-next-line promise/prefer-await-to-then, promise/always-return -- Exit observation outlives session creation.
  if (ownership === undefined) { void runtime.exited.then((code) => {
    void disposeTerminals();
    // An outcome only oar observes: answers our dispose when we caused the
    // exit, stands alone (requestId "") when the runtime died on its own.
    const diagnostic = runtime.diagnostics();
    const cleanExit = code === 0 && diagnostic.signal === null && diagnostic.error === undefined && !reportedStderr(diagnostic, credentials.redact).trim();
    const reason = (cleanExit ? undefined : runtime.exitError?.()?.message) ?? cleanupFailureReason(diagnostic.cleanup);
    kernel.processExited(code, reason);
    turns.onExit();
  }); }

  // Reachability (exited, disposed) is the kernel's gate, read off the
  // stream; the adapter decides only the runtime-specific answers (busy,
  // not_steerable). `runtime.closed` flips synchronously on the process's
  // exit, one microtask before the observer above records the `exited`
  // response: a control landing in that window would otherwise be decided
  // here (rejected "ACP process exited") instead of by the gate, so the
  // exit is let land first.
  let queued = 0;
  let controls = Promise.resolve();
  const track = (promise: Promise<unknown>): void => {
    queued += 1;
    controls = (async (): Promise<void> => {
      try { await promise; } catch { /* One refusal does not poison the next control. */ }
      finally { queued -= 1; }
    })();
  };
  const serial = <T>(run: () => T | Promise<T>): T | Promise<T> => {
    if (ownership === undefined) { return run(); }
    if (queued === 0) {
      const value = run();
      // Async control callbacks are native async functions returning Promise instances, never custom thenables.
      if (value instanceof Promise) { track(value); }
      return value;
    }
    const previous = controls;
    const next = (async (): Promise<T> => { await previous; const value = await run(); return value; })();
    track(next);
    return next;
  };
  // Pre-dispose controls keep their call-time eligibility; on isolated sessions a prompt awaiting pendingCancellation may decide during teardown instead of answering disposed.
  const liveRefusal = (): ResponseBody | null => {
    const unreachable = kernel.unreachable();
    return unreachable !== null && unreachable.code !== "disposed" ? unreachable : null;
  };
  const control = (
    body: RequestBody,
    decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>,
  ): Promise<ControlResult> => kernel.control(body, (request) => serial(() => {
    const pendingCancellation = (body.kind === "prompt" || body.kind === "steer") ? turns.pendingCancellation() : null;
    if (pendingCancellation === null && !(runtime.closed && kernel.unreachable() === null)) { return liveRefusal() ?? decide(request); }
    return (async (): Promise<ResponseBody> => {
      if (pendingCancellation !== null) { try { await pendingCancellation; } catch { /* The abort reports its own failure; later input can still proceed. */ } }
      if (runtime.closed && kernel.unreachable() === null) { await runtime.exited; }
      const refusal = liveRefusal();
      if (refusal !== null) { return refusal; }
      const value = await decide(request);
      return value;
    })();
  }));
  const heldControl = (body: RequestBody, decide: (request: RequestRecord) => ResponseBody): Promise<ControlResult> => kernel.control(body, (request) => serial(() =>
    runtime.closed && kernel.unreachable() === null
      ? (async (): Promise<ResponseBody> => { await runtime.exited; return kernel.unreachable() ?? decide(request); })()
      : kernel.unreachable() ?? decide(request)));

  // A profile without a native steer cannot inject, so the session has no `steer`;
  // neither does one whose connection did not advertise its steer request.
  const { steerParams } = profile;
  const steerRequest = profile.steerRequestAdvertised?.(opened.initialized) === false ? undefined : profile.steerRequest;
  const steer = steerParams === undefined && steerRequest === undefined
    ? {}
    : {
      steer: (input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "steer", input, ...inputOptions }, (request): ResponseBody | Promise<ResponseBody> => {
        if (compaction?.busy() === true) { return { kind: "rejected", code: "busy", reason: "Native compaction is still running" }; }
        // The turn running now, OAR's or the runtime's own, must still be the one running when the RPC goes out.
        const target = turns.active();
        if (target === null) { return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }; }
        if (steerRequest !== undefined) { return sendAcpSteerRequest({ kernel, runtime, profile, capabilities, running: () => turns.active() === target && !target.abortRequested }, request, input, inputOptions); }
        return steerParams === undefined
          ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }
          : turns.steer(target, input, inputOptions, steerParams(input));
      }),
    };

  return credentials.seal({
    id: kernel.sessionId,
    capabilities,
    prompt: (input, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "prompt", input, ...inputOptions }, (request): ResponseBody =>
      (turns.active() === null && !turns.queued() && compaction?.busy() !== true ? turns.begin(request, input, inputOptions?.images) : { kind: "rejected", code: "busy", reason: "busy" })),
    ...steer,
    ...(compaction === null ? {} : { compact: compaction.compact }),
    queue: (input, inputOptions?: InputOptions): Promise<ControlResult> => heldControl({ kind: "queue", input, ...inputOptions }, (request) => turns.hold(input, inputOptions?.images, inputOptions?.inputId, request)),
    // The queue is held here (turns.ts), not by the vendor: an entry can be taken back until the drain sends it.
    withdraw: (inputId: string): Promise<ControlResult> => heldControl({ kind: "withdraw", inputId }, () => turns.withdraw(inputId)),
    abort: (): Promise<ControlResult> => control({ kind: "abort" }, (request): ResponseBody | Promise<ResponseBody> => {
      const state = turns.active();
      if (state === null) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
      return (async (): Promise<ResponseBody> => {
        const claim = turnTerminals.aborting(state, request);
        const answer = await turns.abort(state, request);
        if (answer.kind === "accepted") { claim.accepted(); } else { claim.refused(); }
        return answer;
      })();
    }),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    resources: ownership?.lease.resources ?? runtime.resources,
    dispose: async (): Promise<void> => {
      if (lifecycle !== undefined && ownership !== undefined) {
        await lifecycle.dispose(async run => {
          await serial(async () => {
            ownership.stopRequests(); turns.onExit();
            try { await run(); } finally { ownership.detach(); }
          });
        });
        ownership.stopRequests(); turns.onExit(); ownership.detach();
        return;
      }
      await kernel.dispose(async () => {
        // Native cancel can orphan tools before exit, including detached POSIX tools.
        await runtime.prepareShutdown();
        const state = turns.active();
        if (state !== null && !runtime.closed) {
          if (!state.abortRequested) { runtime.markNativeStop(); }
          await turns.abort(state);
        }
        if (opened.supportsClose && !runtime.closed) {
          runtime.markNativeStop();
          await closeAcpSession(runtime, kernel.sessionId).catch(() => {});
        }
        runtime.kill();
        await runtime.exited;
        await terminalHost.dispose();
      }, () => terminalHost.dispose());
    },
  }, shared?.redact);
}
