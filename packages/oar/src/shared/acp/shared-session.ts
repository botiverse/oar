/* oxlint-disable import/max-dependencies -- Connection ownership composes the existing ACP session mechanisms. */
import type { SessionOptions, StartSession } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
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
  /** Only explicit native links; never infer parenthood from a foreign id. */
  readonly associations: (method: string, params: JsonRecord) => readonly AcpAssociation[];
  readonly sessionId?: (method: string, params: JsonRecord) => string | null;
  /** Per-session native cancel/close, using the vendor's verified protocol. Never kill this process. */
  readonly cleanup: (runtime: AcpProcess, sessionId: string) => Promise<void>;
  /** Redacted connection facts have no session owner and must not be sent to an arbitrary recorder. */
  readonly diagnostic: (entry: AcpUnattributed) => void;
  readonly pending?: { readonly maxFrames?: number; readonly maxBytes?: number; readonly waitMs?: number };
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
  const pool = createProcessPool((configuration: ProcessConfiguration) => {
    const routing = createAcpRouting<AcpClientTarget>({
      associations: shared.associations, diagnostic: shared.diagnostic,
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
    const wire = sharedAcpWire(routing, profile.extensionNotifications ?? []);
    const runtime = startAcpProcess(configuration.command, configuration.args, app, {
      ...(configuration.cwd === undefined ? {} : { cwd: configuration.cwd }),
      env: Object.fromEntries(Object.entries(configuration.env).filter((entry): entry is [string, string] => entry[1] !== null)),
      redact: routing.redact,
      // Raw shared stderr may carry a peer's MCP credentials; it stays behind the pool redactor.
      inheritStderr: false,
      ...wire,
    });
    // A broken transport cannot leave a pool of live controllers awaiting an exit forever.
    void (async (): Promise<void> => { await runtime.connection.closed; runtime.kill(); })();
    const meta: unknown = JSON.parse(configuration.protocol ?? "null");
    let initialized: Promise<JsonRecord> | null = null;
    const initialize = async (): Promise<JsonRecord> => {
      initialized ??= (async (): Promise<JsonRecord> => {
        try {
          return await acpOpenStep(initializeAcpConnection(runtime, { ...profile, initializeMeta: () => asRecord(meta) ?? undefined },
            { cwd: configuration.cwd ?? process.cwd() }, () => {}), "open");
        } catch (error) { runtime.kill(); await runtime.exited; throw routing.redactValue(error); }
      })();
      const response = await initialized;
      return response;
    };
    void (async (): Promise<void> => { await runtime.exited; routing.close(); })();

    return {
      runtime, routing, initialize, exited: runtime.exited, resources: runtime.resources,
      stop: async (): Promise<void> => { runtime.kill(); await runtime.exited; },
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
    const cleanup = async (): Promise<void> => {
      try { await cleanupAcpOwner(async () => {
        if (nativeId !== null && !runtime.closed) { await shared.cleanup(runtime, nativeId); }
      }, async () => { await state.terminalHost.dispose(); }); } catch (error) { throw routing.redactValue(error); }
    };
    try {
      if (options.resume !== undefined) { owner.bind(options.resume); nativeId = options.resume; }
      const ready = await initialize();
      const opened = await openInitializedAcpSession(runtime, profile, options, ready,
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
      const failure = safeError instanceof AcpError && safeError.kind === "process_exited"
        ? acpProcessExitedError(safeError.exitCode, runtime.diagnostics(), routing.redact) : safeError;
      const cleanupError = cleaned[0].status === "rejected" ? routing.redact(String(cleaned[0].reason)) : cleanupFailureReason(runtime.diagnostics().cleanup);
      throw withoutCredentials(appendCleanupFailure(failure, cleanupError));
    }
  }, "shared");
}
