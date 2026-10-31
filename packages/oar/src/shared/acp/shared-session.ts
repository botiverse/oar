/* oxlint-disable import/max-dependencies -- Connection ownership composes the existing ACP session mechanisms. */
import type { SessionOptions, StartSession } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { SessionUnavailableError } from "../../contracts/session-unavailable-error.js";
import { sessionEnvironment } from "../environment.js";
import { cleanupFailureReason, appendCleanupFailure } from "../executable/process-cleanup.js";
import { asRecord, type JsonRecord } from "../json.js";
import { createProcessPool, type ProcessConfiguration } from "../process-pool.js";
import { withSessionCredentials } from "../session-credentials.js";
import { createRoutedAcpClientApp, type AcpClientTarget } from "./client-app.js";
import { AcpError, acpProcessExitedError } from "./errors.js";
import { acpLaunchArgs } from "./launch-args.js";
import { acpMcpOpenGuard, openInitializedAcpSession, type AcpSessionProfile } from "./profile.js";
import { initializeAcpConnection } from "./initialize.js";
import { acpOpenStep } from "./failure.js";
import { sharedAcpWire } from "./shared-wire.js";
import { methods, startAcpProcess, type AcpProcess } from "./process.js";
import { createAcpRouting, type AcpAssociation, type AcpUnattributed } from "./routing.js";
import { acpSession, createAcpSessionState, finishAcpSession } from "./session.js";

/** Evidence-backed vendor choices. This factory alone does not admit a runtime to sharing. */
export interface AcpSharedOptions {
  /** Launch cwd audit belongs in the runtime page. A differing process cwd creates another pool entry. */
  readonly processCwd: (options: SessionOptions) => string;
  /** Reserve vendor process-lifetime state before any native open. Null reserves it; a reason refuses it. */
  readonly reserveSession?: (runtime: AcpProcess, options: SessionOptions) => Promise<string | null>;
  /** Check the running process before any native open, independently of the installation snapshot. */
  readonly initializationRefusal?: (response: JsonRecord) => string | null;
  /** Only explicit native links; never infer parenthood from a foreign id. */
  readonly associations: (method: string, params: JsonRecord) => readonly AcpAssociation[];
  /** Consistency checks against accepted links. A late claim never grants ownership. */
  readonly associationChecks?: (method: string, params: JsonRecord) => readonly AcpAssociation[];
  readonly sessionId?: (method: string, params: JsonRecord) => string | null;
  /** Per-session native cancel/close, using the vendor's verified protocol. Never kill this process. */
  readonly cleanup: (runtime: AcpProcess, sessionId: string) => Promise<void>;
  /** Redacted connection facts have no session owner and must not be sent to an arbitrary recorder. */
  readonly diagnostic: (entry: AcpUnattributed) => void;
  readonly pending?: { readonly maxFrames?: number; readonly maxBytes?: number; readonly waitMs?: number; readonly requestWaitMs?: number };
}

/** Attempt native cleanup and hosted terminal cleanup independently, retaining both failures. */
export async function cleanupAcpOwner(native: () => Promise<void>, terminals: () => Promise<void>, timeoutMs = 4000): Promise<void> {
  const bounded = async (work: () => Promise<void>, name: string): Promise<void> => {
    const deadline = Promise.withResolvers<void>();
    const timer = setTimeout(() => { deadline.reject(new Error(`${name} cleanup timed out; work may still be running`)); }, timeoutMs);
    try { await Promise.race([(async (): Promise<void> => { await work(); })(), deadline.promise]); }
    finally { clearTimeout(timer); }
  };
  const results = await Promise.allSettled([bounded(native, "native session"), bounded(terminals, "hosted terminals")]);
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
  if (failures.length > 0) { throw new Error(failures.join("; ")); }
}

/** A fresh factory owns a fresh pool. Native runtime definitions opt in only in their own admission PR. */
export function sharedAcpSession(profile: AcpSessionProfile, shared: AcpSharedOptions): StartSession {
  const isolated = acpSession(profile);
  const pool = createProcessPool((configuration: ProcessConfiguration, retire) => {
    const routing = createAcpRouting<AcpClientTarget>({
      associations: shared.associations, diagnostic: shared.diagnostic,
      ...(shared.associationChecks === undefined ? {} : { associationChecks: shared.associationChecks }),
      ...(shared.sessionId === undefined ? {} : { sessionId: shared.sessionId }), ...shared.pending,
    });
    const app = createRoutedAcpClientApp({
      target: async (method, params, requestId) => {
        const { target, ingress, active } = await routing.request(method, params, requestId);
        return { ...target, active, receivedAt: ingress.receivedAt };
      },
      update: (notification) => { routing.notify(methods.client.session.update, notification, (target, ingress) => { target.hooks.update(notification, ingress.receivedAt); }); },
      extension: (method, params) => { routing.notify(method, params, (target, ingress) => { target.hooks.extension(method, params, ingress.receivedAt, ingress.afterOpen); }); },
      extensionNotifications: profile.extensionNotifications ?? [],
    });
    const wire = sharedAcpWire(routing, profile.extensionNotifications ?? [], (id) => {
      void (async (): Promise<void> => {
        try {
          await cleanupAcpOwner(async () => { if (!runtime.closed) { await shared.cleanup(runtime, id); } }, async () => {});
          routing.diagnostic("cancelled_session_new_cleanup", { sessionId: id, result: { kind: "completed" } }, "retired");
        } catch (error) {
          routing.diagnostic("cancelled_session_new_cleanup", { sessionId: id, result: { kind: "failed", reason: error instanceof Error ? error.message : String(error) } }, "retired");
        }
      })();
    }, profile.sessionStartTimeoutMs ?? profile.requestTimeoutMs ?? 15_000);
    const runtime = startAcpProcess(configuration.command, configuration.args, app, {
      ...(configuration.cwd === undefined ? {} : { cwd: configuration.cwd }),
      env: Object.fromEntries(Object.entries(configuration.env).filter((entry): entry is [string, string] => entry[1] !== null)),
      redact: routing.redact,
      // Raw shared stderr may carry a peer's MCP credentials; it stays behind the pool redactor.
      inheritStderr: false,
      ...wire,
    });
    // A broken transport cannot leave a pool of live controllers awaiting an exit forever.
    let stopping = false;
    const stop = (): void => {
      if (stopping) { return; }
      stopping = true; retire(); wire.close(); runtime.kill();
    };
    runtime.connection.signal.addEventListener("abort", stop, { once: true });
    if (runtime.connection.signal.aborted) { stop(); }
    const meta: unknown = JSON.parse(configuration.protocol ?? "null");
    let initialized: Promise<{ response: JsonRecord; refusal: string | null }> | null = null;
    const initialize = async (): Promise<{ response: JsonRecord; refusal: string | null }> => {
      initialized ??= (async (): Promise<{ response: JsonRecord; refusal: string | null }> => {
        try {
          const response = await acpOpenStep(initializeAcpConnection(runtime, { ...profile, initializeMeta: () => asRecord(meta) ?? undefined },
            { cwd: configuration.cwd ?? process.cwd() }, () => {}), "open");
          const refusal = shared.initializationRefusal?.(response) ?? null;
          if (refusal !== null) { stop(); await runtime.exited; }
          return { response, refusal };
        } catch (error) { stop(); await runtime.exited; throw routing.redactValue(error); }
      })();
      const response = await initialized;
      return response;
    };
    void (async (): Promise<void> => { await runtime.exited; wire.close(); routing.close(); })();

    return {
      runtime, routing, initialize, exited: runtime.exited, resources: runtime.resources,
      stop: async (): Promise<void> => { stop(); await runtime.exited; },
      exitReason: (): string | undefined => cleanupFailureReason(runtime.diagnostics().cleanup),
    };
  });
  return withSessionCredentials(async (installation, options, credentials, context) => {
    if (installation.via !== "executable") { throw new Error("ACP runtimes require an executable installation"); }
    profile.validateOptions?.(options);
    const withoutCredentials = acpMcpOpenGuard(options.mcpServers, credentials.redact);
    const environment = sessionEnvironment(options.env);
    const lease = await pool.acquire({
      command: installation.command, args: acpLaunchArgs(profile, options),
      env: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      cwd: shared.processCwd(options), protocol: JSON.stringify(profile.initializeMeta?.(options) ?? null),
    }, "shared");
    const { runtime, routing, initialize } = lease.process;
    // Ownership conflicts must not become a directory-policy fallback to another controller.
    let refusal: string | null = null;
    try {
      if (options.resume !== undefined && routing.inUse(options.resume)) {
        throw new SessionUnavailableError(options.resume, "ACP native session id is already controlled on this connection", {
          reason: "in_use", method: "oar/open", native: { sessionId: options.resume },
        });
      }
      refusal = await shared.reserveSession?.(runtime, options) ?? null;
    } catch (error) { await lease.dispose(); throw withoutCredentials(error); }
    if (refusal !== null) {
      if (context.requested === "auto") {
        // A concurrent fallback must not race a pool's first initialization
        // with a second cold process using the same native data directory.
        try { await initialize(); }
        catch { /* This controller needs an independent process, even if the shared one could not start. */ }
        finally { await lease.dispose(); }
        return isolated(installation, options, { requested: "auto", placement: "isolated" });
      }
      await lease.dispose();
      throw new UnsupportedOptionError("placement", refusal);
    }
    // This is a pre-open decision, never a retry of a native resume or configuration failure.
    if (options.resume !== undefined && routing.retired(options.resume)) {
      await lease.dispose();
      if (context.requested === "auto") {
        return isolated(installation, options, { requested: "auto", placement: "isolated" });
      }
      throw new UnsupportedOptionError("placement", "ACP native session id is retired on this shared connection; resume requires an isolated process");
    }
    const state = createAcpSessionState(profile, options, environment, (method, params) => owner.associations(method, params));
    const owner = routing.attach({ terminal: state.terminalHost, hooks: state.hooks }, credentials);
    let nativeId: string | null = null;
    let initializationRefusal: string | null = null;
    const cleanup = async (): Promise<void> => {
      try { await cleanupAcpOwner(async () => {
        if (nativeId !== null && !runtime.closed) { await shared.cleanup(runtime, nativeId); }
      }, async () => { await state.terminalHost.dispose(); }); } catch (error) { throw routing.redactValue(error); }
    };
    try {
      if (options.resume !== undefined) { owner.reserve(options.resume); nativeId = options.resume; }
      const ready = await initialize();
      initializationRefusal = ready.refusal;
      if (initializationRefusal !== null) { throw new UnsupportedOptionError("placement", initializationRefusal); }
      const opened = await openInitializedAcpSession(runtime, profile, options, ready.response,
        (step) => { state.recorder.step(step.method, step.response); },
        (id) => { owner.bind(id); nativeId = id; owner.opened(); });
      return finishAcpSession(profile, options, credentials, runtime, opened, state, {
        lease, cleanup, stopRequests: () => { owner.stopRequests(); }, detach: () => { owner.dispose(); }, redact: routing.redactValue,
      });
    } catch (error) {
      const safeError = routing.redactValue(error);
      owner.stopRequests();
      const cleaned = await Promise.allSettled([cleanup()]);
      owner.dispose();
      await lease.dispose();
      if (initializationRefusal !== null && context.requested === "auto") {
        return isolated(installation, options, { requested: "auto", placement: "isolated" });
      }
      const failure = safeError instanceof AcpError && safeError.kind === "process_exited"
        ? acpProcessExitedError(safeError.exitCode, runtime.diagnostics(), routing.redact) : safeError;
      const cleanupError = cleaned[0].status === "rejected" ? routing.redact(String(cleaned[0].reason)) : cleanupFailureReason(runtime.diagnostics().cleanup);
      throw withoutCredentials(appendCleanupFailure(failure, cleanupError));
    }
  }, "shared");
}
