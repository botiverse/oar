// BYOK change: Modified from OAR 95c6547 for injected processes, an explicit environment, a record consumer and session credential redaction without sealSession (Apache-2.0).
/* oxlint-disable import/max-dependencies -- Session assembly wires the environment, process, terminal host, recorder and control machinery. */
/* oxlint-disable typescript/promise-function-async -- SDK callbacks deliberately return the SDK's native promises. */
import type { AvailableInstallation } from "../../contracts/installation.js";
import type {
  AdapterSession,
  ControlResult,
  InputOptions,
  RawEvent,
  RequestBody,
  RequestRecord,
  ResponseBody,
  SessionOptions,
} from "../../contracts/session.js";
// BYOK change: Build the session credential redactor directly; upstream withSessionCredentials imports sealSession.
import { sessionCredentialRedactor, type CredentialRedactor } from "../credential-redactor.js";
import { manualCompaction, type CompactionOperation } from "../manual-compaction.js";
import { createSessionKernel } from "../session-kernel.js";
import { createAcpClientApp, type AcpClientHooks } from "./client-app.js";
import {
  acpMcpOpenGuard,
  closeAcpSession,
  createUsageUpdateGate,
  openAcpSession,
  type AcpSessionProfile,
} from "./profile.js";
import { acpLaunchArgs } from "./launch-args.js";
import { startAcpProcess, type SpawnAcpLineProcess } from "./process.js";
import { createAcpRecorder } from "./records.js";
import { createAcpTerminalHost, type SpawnAcpTerminal } from "./terminal.js";
import { createAcpTurns, type ActiveTurn } from "./turns.js";
import { acpTakesImages } from "./prompt.js";
import { createAcpTokenUsage } from "./token-usage.js";
import { createAcpOpening } from "./opening.js";
import { createAcpConfigUpdates } from "./config-updates.js";
import type { JsonRecord } from "../json.js";
import { createAcpNativeTurnTracker } from "./native-turns.js";
import { sendAcpSteerRequest } from "./steer-request.js";

export type { AcpSessionProfile } from "./profile.js";

/*
 * ACP mapping onto the record stream (shared by grok and kimi; profiles carry the vendor bits):
 * - every `session/update` is ONE event record, native verbatim, for WHATEVER
 *   session id it names: a foreign id is a derived child session (records.ts).
 * - listed vendor notifications are recorded verbatim except credential redaction.
 * - runtime→app requests (permission, terminal) are toApp request records;
 *   oar's automatic answer is the matching `answered` response (client-app.ts).
 * - prompt / steer / queue / withdraw / abort / dispose are toRuntime requests answered
 *   accepted-or-rejected; the turn's end is the runtime's own prompt answer
 *   (turns.ts) or the process exit oar observed (`exited` response).
 */

// BYOK change: the caller passes the complete filtered environment, so a value is never a null removal.
export type AcpSessionOptions = Omit<SessionOptions, "env" | "endTurnProcessesOnAbort" | "retainedBytes"> & { readonly env: Readonly<Record<string, string>> };

// BYOK change: the record consumer is registered before any record is appended.
export interface AcpSessionHooks {
  /** The native session id, before any record is delivered; a throw fails the open. */
  readonly onReady?: (sessionId: string) => void;
  /** A kernel observer from seq 0. The kernel swallows its errors, so it fails the session itself. */
  readonly onRecord?: (record: RawEvent) => void;
  /** BYOK change: answers each `session/request_permission`. Absent, every request is cancelled. */
  readonly onPermission?: AcpClientHooks["permission"];
}

// BYOK change: the caller owns the agent process, every hosted terminal process and the environment.
export type StartAcpSession = (
  spawnLineProcess: SpawnAcpLineProcess,
  spawnTerminal: SpawnAcpTerminal,
  installation: AvailableInstallation,
  options: AcpSessionOptions,
  hooks?: AcpSessionHooks,
) => Promise<AdapterSession>;

export function acpSession(profile: AcpSessionProfile): StartAcpSession {
  // BYOK change: Upstream withSessionCredentials without sealSession. One redactor per open keeps
  // opening failures, retained records and later control errors under the same credential rules.
  return async (spawnLineProcess, spawnTerminal, installation, options, hooks = {}) => {
    const credentials = sessionCredentialRedactor(options);
    try { return await openAcpRuntimeSession(profile, spawnLineProcess, spawnTerminal, installation, options, hooks, credentials); }
    catch (error) { throw credentials.redactValue(error); }
  };
}

async function openAcpRuntimeSession(
  profile: AcpSessionProfile,
  spawnLineProcess: SpawnAcpLineProcess,
  spawnTerminal: SpawnAcpTerminal,
  installation: AvailableInstallation,
  options: AcpSessionOptions,
  hooks: AcpSessionHooks,
  credentials: CredentialRedactor,
): Promise<AdapterSession> {
    if (installation.via !== "executable") {
      throw new Error("ACP runtimes require an executable installation");
    }
    profile.validateOptions?.(options);
    // SessionOptions.mcpServers go out in the open request (mcp-servers.ts):
    // a list with an empty or repeated name fails before anything starts,
    // and an open that fails reports no credential they carry.
    const withoutCredentials = acpMcpOpenGuard(options.mcpServers, credentials.redact);
    const args = acpLaunchArgs(profile, options);
    // BYOK change: explicit environment; nothing ambient is merged.
    if (options.env === undefined) throw new Error("ACP session requires an explicit filtered environment");
    const environment = options.env;
    const terminalHost = createAcpTerminalHost(spawnTerminal, options.cwd, environment, {
      shellCommand: profile.terminalShellCommand === true,
    });
    // The recorder queues everything until the handshake reveals the session
    // id and the kernel can be bound (records.ts).
    const usageGate = createUsageUpdateGate();
    const nativeTurns = createAcpNativeTurnTracker(profile.nativeTurns);
    const tokenUsage = createAcpTokenUsage(profile, nativeTurns?.sentByOar);
    const opening = createAcpOpening();
    const configUpdates = createAcpConfigUpdates();
    const recorder = createAcpRecorder(usageGate, profile.attributeUpdate, tokenUsage, undefined, profile.projectUpdate, profile.projectExtension, nativeTurns);
    const client = createAcpClientApp(terminalHost, {
      update: (notification, receivedAt) => {
        recorder.update(notification, receivedAt);
        configUpdates.observe(notification);
      },
      extension: (method, params, receivedAt, afterOpen) => {
        recorder.extension(method, profile.redactExtensionNotification?.(method, params) ?? params, afterOpen ?? opening.afterOpen(params), receivedAt);
      },
      requested: (id, method, params, receivedAt) => {
        recorder.requested(id, method, params, receivedAt);
      },
      answered: (id, reply) => {
        recorder.answered(id, reply);
      },
      extensionNotifications: profile.extensionNotifications ?? [],
      ...(hooks.onPermission === undefined ? {} : { permission: hooks.onPermission }),
    });
    const runtime = startAcpProcess(spawnLineProcess, installation.command, args, client, { cwd: options.cwd, env: environment, redact: credentials.redact, opening });
    const release = async (): Promise<void> => {
      runtime.kill();
      await runtime.exited;
      await terminalHost.dispose();
    };
    const opened = await openAcpSession(runtime, profile, options, (step) => {
      recorder.step(step.method, step.response);
    }, configUpdates).catch(async (error: unknown) => {
      await release();
      throw withoutCredentials(error);
    });
    // BYOK change: the record consumer observes from seq 0: it registers before the recorder binds.
    const kernel = createSessionKernel(opened.sessionId, credentials.redactValue);
    if (hooks.onRecord !== undefined) kernel.rawEvents(hooks.onRecord);
    try {
      hooks.onReady?.(opened.sessionId);
    } catch (error) {
      await release();
      throw error;
    }

    let disposeRequest: RequestRecord | null = null;
    const capabilities = { ...profile.capabilities, images: profile.capabilities.images ?? acpTakesImages(opened.initialized) };
    let compaction: ReturnType<typeof manualCompaction> | null = null;
    const turns = createAcpTurns({ operationBusy: () => compaction?.busy() === true, kernel, runtime, profile, usageGate, capabilities, promptMeta: profile.promptMeta?.(options), promptUsage: (result) => tokenUsage.prompt(result),
      ...(nativeTurns === undefined ? {} : { native: { promptParams: (inputId: string | undefined): JsonRecord => ({ _meta: nativeTurns.name(inputId) }), afterClose: nativeTurns.afterOarTurn } }),
    });
    // The runtime's own turn is the active turn: prompt is busy, held input waits, steer and abort reach it.
    nativeTurns?.bind({ active: () => turns.active(), adopt: () => turns.beginOperation(null), release: (turn) => {
      const active = turns.active();
      if (active === turn) { turns.finishOperation(active); }
    } });
    // Bound only now: frames queued since the open answer may start a native turn, which needs the driver above.
    recorder.bind(kernel);
    const createCompaction = profile.compaction;
    if (createCompaction !== undefined) {
      compaction = manualCompaction(kernel, {
        // BYOK change: no pending cancellation observation to wait for; see `abort` in turns.ts.
        busy: () => turns.active() !== null || turns.queued(),
        busyReason: "Wait for native input and cancellation to finish before compacting",
        settledBy: "native_response",
        released: () => { queueMicrotask(() => { turns.drain(); }); },
        create: (): CompactionOperation => {
          const operation = createCompaction(kernel, runtime, (response) => tokenUsage.prompt(response));
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
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/always-return -- Exit observation outlives session creation.
    void runtime.exited.then((code) => {
      // BYOK change: the session's dispose awaits and reports this same disposal.
      void terminalHost.dispose().catch(() => {});
      // An outcome only oar observes: answers our dispose when we caused the
      // exit, stands alone (requestId "") when the runtime died on its own.
      kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
      turns.onExit();
    });

    // Reachability (exited, disposed) is the kernel's gate, read off the
    // stream; the adapter decides only the runtime-specific answers (busy,
    // not_steerable). `runtime.closed` flips synchronously on the process's
    // exit, one microtask before the observer above records the `exited`
    // response: a control landing in that window would otherwise be decided
    // here (rejected "ACP process exited") instead of by the gate, so the
    // exit is let land first.
    const control = async (
      body: RequestBody,
      decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>,
    ): Promise<ControlResult> => {
      if (runtime.closed && kernel.unreachable() === null) {
        await runtime.exited;
      }
      return kernel.control(body, decide);
    };

    // A profile without a native steer cannot inject, so the session has no `steer`.
    const { steerParams, steerRequest } = profile;
    const steer = steerParams === undefined && steerRequest === undefined
      ? {}
      : {
        steer: (input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "steer", input, ...inputOptions }, (request): ResponseBody | Promise<ResponseBody> => {
          if (compaction?.busy() === true) { return { kind: "rejected", code: "busy", reason: "Native compaction is still running" }; }
          // The turn running now, OAR's or the runtime's own, must still be the one running when the RPC goes out.
          const target = turns.active();
          if (steerRequest !== undefined) { return sendAcpSteerRequest({ kernel, runtime, profile, capabilities, running: () => target !== null && turns.active() === target && !target.abortRequested }, request, input, inputOptions); }
          const state = turns.active();
          return state === null || steerParams === undefined
            ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }
            : turns.steer(state, input, inputOptions, steerParams(input));
        }),
      };

    // BYOK change: The upstream credentials.seal guard without sealSession: a control's thrown error is redacted.
    // As upstream, compact also redacts its outcome: its reasons can carry native error text.
    const guard = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>, cleanResult = false) =>
      async (...args: Args): Promise<Result> => {
        try { const result = await method(...args); return cleanResult ? credentials.redactValue(result) : result; } catch (error) { throw credentials.redactValue(error); }
      };
    return { // BYOK change: raw adapter without sealSession/observe dependencies.
      id: kernel.sessionId,
      capabilities,
      prompt: guard((input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "prompt", input, ...inputOptions }, (request): ResponseBody =>
        (turns.active() === null && !turns.queued() && compaction?.busy() !== true ? turns.begin(request, input, inputOptions?.images) : { kind: "rejected", code: "busy", reason: "busy" }))),
      ...(steer.steer === undefined ? {} : { steer: guard(steer.steer) }),
      ...(compaction === null ? {} : { compact: guard(compaction.compact, true) }),
      queue: guard((input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "queue", input, ...inputOptions }, (request) => turns.hold(input, inputOptions?.images, inputOptions?.inputId, request))),
      // The queue is held here (turns.ts), not by the vendor: an entry can be taken back until the drain sends it.
      withdraw: guard((inputId: string): Promise<ControlResult> => control({ kind: "withdraw", inputId }, () => turns.withdraw(inputId))),
      abort: guard((): Promise<ControlResult> => control({ kind: "abort" }, (): ResponseBody | Promise<ResponseBody> => {
        const state = turns.active();
        return state === null ? { kind: "rejected", code: "no_active_turn", reason: "no active turn" } : turns.abort(state);
      })),
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      // BYOK change: no `resources` reader; the SDK process-tree authority owns the tree.
      dispose: guard(async () => {
        if (disposeRequest !== null) {
          // Already released: the stream holds our dispose request. BYOK change:
          // a retry after a failed terminal reap reaps what is still alive.
          await terminalHost.dispose();
          return;
        }
        // Read BEFORE this dispose is recorded: only an observed exit can say
        // so here, and it is the stream's word, not an adapter flag.
        const gone = kernel.unreachable() !== null;
        disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
        if (gone) {
          // The exit is already recorded (an unrequested `exited` response, requestId "");
          // nothing is left to release, so the dispose is answered here, as
          // the claude and codex adapters do (kimi 0.42.0 kill-runtime run,
          // 2026-09-11: the dispose request stood unanswered before this).
          kernel.respond(disposeRequest.id, { kind: "accepted" });
          await terminalHost.dispose();
          return;
        }
        // BYOK change: no prepareShutdown/markNativeStop; the SDK process-tree
        // authority reads the descendants itself before it signals the tree.
        const state = turns.active();
        if (state !== null && !runtime.closed) {
          await turns.abort(state);
        }
        if (opened.supportsClose && !runtime.closed) {
          await closeAcpSession(runtime, kernel.sessionId).catch(() => {});
        }
        runtime.kill();
        await runtime.exited;
        await terminalHost.dispose();
      }),
    };
}
