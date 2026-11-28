/* oxlint-disable import/max-dependencies -- Session profiles and assembly wire the native control, projection and lifecycle helpers. */
/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import type { CompactionOperation } from "../manual-compaction.js";
import type { SessionKernel } from "../session-kernel.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { methods } from "@agentclientprotocol/sdk";
import type { ContextUsage, RawEvent, RuntimeEventBody, SessionCapabilities, SessionOptions, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import { initializeAcpConnection } from "./initialize.js";
import type { AcpDerivedSessionHooks } from "./derived-sessions.js";
import type { AcpRawToolOutputReader } from "./projection.js";
import type { AcpSteerRequestHooks } from "./steer-request.js";
import { acpAdditionalDirectories } from "./additional-directories.js";
import { configureAcpModel, type AcpModelConfiguration } from "./model-configuration.js";
import { waitForOpenReadiness, type AcpOpenObservers, type AcpOpenReadiness } from "./open-readiness.js";
import { acpResumeFailure, acpOpenStep, type AcpFailureReader, type AcpOpenFailureReader } from "./failure.js";
import { acpMcpServersParam } from "./mcp-servers.js";
import { type AcpProcess, withAcpDeadline } from "./process.js";
import { refuseResumeElsewhere, unknownResumeCwd } from "./resume-cwd.js";

export { promptAcp } from "./prompt.js";
export { createUsageUpdateGate, type UsageUpdateGate } from "./usage-wait.js";
export { acpMcpOpenGuard } from "./mcp-servers.js";
export interface AcpSessionProfile extends AcpDerivedSessionHooks, AcpSteerRequestHooks {
  /** Native compaction control, absent when the installed protocol cannot prove completion. */
  readonly compaction?: (kernel: SessionKernel, runtime: AcpProcess, promptUsage: (response: JsonRecord) => RuntimeEventBody | null) => CompactionOperation;
  /** Vendor facts on an extension notification; its envelope retains native attribution. */
  readonly projectExtension?: (method: string, params: JsonRecord) => readonly RuntimeEventBody[];
  /** Additional vendor facts on a session update; attribution remains the recorder's responsibility. */
  readonly projectUpdate?: (update: JsonRecord, receivedAt: number) => readonly RuntimeEventBody[];
  /** Vendor-specific tool result reading when closing `tool_call_update.content` is absent (for example, Grok MCP `rawOutput`). */
  readonly projectRawToolOutput?: AcpRawToolOutputReader;
  /** Vendor attribution for forwarded updates. The original notification is always recorded verbatim. */
  readonly attributeUpdate?: (notification: unknown) => { readonly sessionId: string; readonly parent: string } | null;
  readonly args: readonly string[] | ((options: SessionOptions) => readonly string[]);
  /** Resolve the child process environment; defaults to `sessionEnvironment(options.env)`. */
  readonly environment?: (options: SessionOptions) => NodeJS.ProcessEnv;
  /** Where SessionOptions.launchArgs join `args` when not after them (grok: before `stdio`); launch-args.ts. */
  readonly withLaunchArgs?: (args: readonly string[], launchArgs: readonly string[]) => readonly string[];
  /** What this runtime's ACP surface lets the adapter carry (docs/spec attribution tier included). */
  readonly capabilities: Omit<SessionCapabilities, "images"> & { readonly images?: boolean }; // images: what `initialize` advertised, unless set on evidence that it is wrong
  /** Bounded requests after initialization; default 15 seconds. */
  readonly requestTimeoutMs?: number;
  readonly openReadiness?: (options: SessionOptions) => AcpOpenReadiness | undefined;
  /** Only initialize; default 60 seconds, independent of requestTimeoutMs. */
  readonly initializeTimeoutMs?: number;
  /** Isolated process startup only. Returns an idempotent release for initialize, exit or failed open. */
  readonly acquireStartup?: (options: SessionOptions, timeoutMs: number) => Promise<() => void>;
  readonly maxInputBytes?: number; // OAR's bound on one input's UTF-8 bytes, for a runtime seen to cut long input silently: longer ones are refused (`unsupported`, `input_too_large`)
  /** Only session/new and session/resume, when native startup work needs a larger bound. */
  readonly sessionStartTimeoutMs?: number;
  /** Only session/load (replays saved history); default 60 seconds, independent of requestTimeoutMs and sessionStartTimeoutMs. */
  readonly sessionLoadTimeoutMs?: number;
  readonly abortTimeoutMs?: number;
  /** Compatibility for agents that put a fully quoted shell line in `command`. */
  readonly terminalShellCommand?: boolean;
  /**
   * Vendor notifications to record verbatim (children, tasks, usage).
   * The SDK only routes registered methods: list every known method.
   */
  readonly extensionNotifications?: readonly string[];
  /** Credential-only exception to verbatim recording; applied before queuing or publishing a notification. */
  readonly redactExtensionNotification?: (method: string, params: JsonRecord) => JsonRecord;
  readonly initializeMeta?: (options: SessionOptions) => JsonRecord | undefined;
  /**
   * Switch models with `session/set_config_option` on `model`, for agents whose `set_model` answers
   * `{}` and pushes nothing (agy_acp_server 1.2.1): only that answer reports the applied model.
   */
  readonly modelViaConfigOption?: boolean;
  /** Vendor selection policy; all native calls retain shared confirmation and recording. */
  readonly configureModel?: AcpModelConfiguration;
  /** Wait for each native config notification before the next setting; `"when_stale"` waits only when the RPC reply still shows a different value. */
  readonly confirmConfigOptionUpdates?: boolean | "when_stale";
  /**
   * The agent resumes a session in the directory it was created in, whatever
   * `cwd` the resume names (kimi 2.1.1, probed 2026-10-03: a resume naming B
   * ran its shell as `cd <A> && …`). OAR reads the session's own directory
   * from `session/list` and refuses a resume elsewhere or when the saved cwd
   * cannot be confirmed. No list capability or missing entry is not consent.
   */
  readonly resumeKeepsSessionCwd?: boolean;
  /** Convert the adapter's session/list cwd spelling for directory identity checks. */
  readonly normalizeListedCwd?: (listedCwd: string) => string;
  /** Whole-history copies via the advertised session/fork method. */
  readonly wholeSessionFork?: boolean;
  /**
   * Dispose without the advertised `session/close`: the agent's close ends the
   * saved session for every client, after which a resume is refused, while
   * ending the process only detaches this connection.
   */
  readonly detachOnDispose?: boolean;
  /** A native resume/load error must positively identify a missing session. */
  readonly isResumeNotFound?: (native: JsonRecord) => boolean;
  readonly sessionMeta?: (options: SessionOptions, initialized: JsonRecord) => JsonRecord | undefined;
  /** Native metadata on every prompt RPC, including held queue entries and steer. */
  readonly promptMeta?: (options: SessionOptions) => JsonRecord | undefined;
  readonly selectAuthMethod?: (initialized: JsonRecord) => string | undefined;
  readonly validateOptions?: (options: SessionOptions) => void;
  readonly configureSession?: (context: {
    /** Each native call retains its own deadline and protocol error context. */
    readonly request: (method: string, params: JsonRecord) => Promise<unknown>;
    readonly sessionId: string;
    readonly response: JsonRecord;
    readonly options: SessionOptions;
  }) => Promise<void>;
  /** Return prompt-level extension fields for the runtime's native steer; absent when the runtime cannot steer, and then the session has no `steer`. Exclusive with `steerRequest` (steer-request.ts). */
  readonly steerParams?: (input: string) => JsonRecord;
  /**
   * Turns the runtime runs without a prompt from OAR (grok: a sub-agent's
   * completion wake, a late interjection). OAR names each prompt it sends;
   * any root turn under another name is the runtime's own.
   */
  readonly nativeTurns?: AcpNativeTurns;
  /** A steer replaces the native prompt: fold all admitted answers as one turn (grok sendNow). Otherwise only the original prompt ends the turn. */
  readonly steerSupersedesPrompt?: boolean;
  /** A replacing steer settles the prior RPC early; a later failure reports the loop outcome only after every earlier RPC has replied (agy CLI). */
  readonly steerOutcomeIsLatest?: boolean;
  /** Native validation refusal, even when an earlier prompt has already answered naturally. */
  readonly isSteerRefusal?: (error: unknown) => boolean;
  readonly promptContextUsage?: (response: JsonRecord) => ContextUsage | null;
  /**
   * Tokens billed by ONE prompt (grok `_meta.usage`, live 2026-09-11), summed
   * over that prompt's model calls, not the session. The shared accumulator
   * combines them with independent vendor ledgers and emits cumulative usage.
   */
  readonly promptTokenUsage?: (response: JsonRecord, initialized: JsonRecord) => TokenTotals | null;
  /** Independent root ledger, never overlapping promptTokenUsage: `sentByOar` names prompts whose answer already carries their tokens. The native key deduplicates delivery; replayed reports only remember that identity. Child notifications are excluded by the recorder. */
  readonly spontaneousTokenUsage?: (method: string, params: JsonRecord, sentByOar: (promptId: string) => boolean) => { readonly key: string; readonly tokens: TokenTotals; readonly replayed?: boolean } | null;
  readonly promptOutcome?: (response: JsonRecord, turnRecords: () => readonly RawEvent[]) => TurnOutcome | null;
  /** Classify a rejected open or model-selection RPC; null leaves it to the generic rules (failure.ts). */
  readonly openFailure?: AcpOpenFailureReader;
  /** Classify a prompt the agent answered with an error, from the error and the turn's frames; null leaves it to the generic rules (failure.ts). */
  readonly failureOutcome?: AcpFailureReader;
  /**
   * Hold the `session/prompt` answer back until a trailing `usage_update` lands
   * (kimi-code f9ca33376 resolves the prompt before `void emitUsageUpdate()`),
   * bounded by `usageUpdateTimeoutMs`; on timeout record the answer as-is.
   */
  readonly usageUpdateAfterPrompt?: boolean;
  /** Bound for `usageUpdateAfterPrompt`; default 500 ms. */
  readonly usageUpdateTimeoutMs?: number;
}
/** What one root notification says about the runtime's native turns. */
export type AcpNativeTurnReport =
  /** The runtime's prompt queue: the prompt it is running (null when none) and the ones it holds. */
  | { readonly kind: "queue"; readonly running: string | null; readonly queued: readonly string[] }
  /** A prompt's turn ended, by the runtime's own report; `key` identifies that report across repeated delivery. */
  | { readonly kind: "ended"; readonly promptId: string; readonly outcome: TurnOutcome; readonly key?: string };

export interface AcpNativeTurns {
  /** Prompt-level fields naming one OAR prompt (merged into `_meta`). */
  readonly promptMeta: (promptId: string) => JsonRecord;
  /** Read a live root notification; replays and other sessions never reach this. */
  readonly read: (method: string, params: JsonRecord) => AcpNativeTurnReport | null;
}

export interface OpenedAcpSession {
  readonly initialized: JsonRecord;
  readonly response: JsonRecord;
  readonly sessionId: string;
  /** Which native call opened the session. */
  readonly openMethod: "session/new" | "session/resume" | "session/load" | "session/fork";
  /** The agent advertised `session/close`. */
  readonly supportsClose: boolean;
  /** The model switch response, when a model was requested; grok reports the applied model in its `_meta`, antigravity in its `configOptions`. */
  readonly setModelResponse?: JsonRecord;
}

/** Native handshake answers in wire order, for opening records. */
export type AcpOpenObserver = (step: { readonly method: string; readonly response: JsonRecord }) => void;

export function hasAcpCapability(value: unknown): boolean { return value === true || asRecord(value) !== null; }

function responseRecord(method: string, value: unknown): JsonRecord {
  const response = asRecord(value);
  if (response === null) {
    throw new TypeError(`ACP ${method} returned a non-object response`);
  }
  return response;
}

export async function closeAcpSession(process: AcpProcess, sessionId: string): Promise<void> {
  const method = methods.agent.session.close;
  await withAcpDeadline(
    process,
    method,
    2000,
    (requestOptions) => process.connection.agent.request(
      method,
      { sessionId },
      requestOptions,
    ),
  );
}

function savedSessionMethod(
  options: SessionOptions, profile: AcpSessionProfile, capabilities: JsonRecord | null, sessionCapabilities: JsonRecord | null,
): "session/fork" | "session/resume" | "session/load" {
  if (options.fork !== undefined) {
    if (options.fork.through !== undefined) {
      throw new UnsupportedOptionError("fork", "ACP session/fork accepts only a whole session and cannot cut at fork.through");
    }
    if (profile.wholeSessionFork !== true || !hasAcpCapability(sessionCapabilities?.fork)) {
      throw new UnsupportedOptionError("fork", "this ACP runtime has no verified, advertised session/fork method");
    }
    return methods.agent.session.fork;
  }
  if (hasAcpCapability(sessionCapabilities?.resume)) { return methods.agent.session.resume; }
  if (capabilities?.loadSession === true) { return methods.agent.session.load; }
  throw new Error("ACP runtime does not support session resume");
}

function openedSessionId(method: string, response: JsonRecord, source?: string): string {
  const id = response.sessionId;
  if (typeof id !== "string" || id.trim() === "") { throw new TypeError(`ACP ${method} returned no session id`); }
  if (id === source) { throw new TypeError(`ACP ${method} returned the source session id`); }
  return id;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_LOAD_TIMEOUT_MS = 60_000;

function openMethodTimeoutMs(profile: AcpSessionProfile, method: OpenedAcpSession["openMethod"]): number {
  const fallback = profile.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return method === methods.agent.session.load ? (profile.sessionLoadTimeoutMs ?? Math.max(fallback, DEFAULT_SESSION_LOAD_TIMEOUT_MS)) : (profile.sessionStartTimeoutMs ?? fallback);
}

async function createOrResume(
  process: AcpProcess, profile: AcpSessionProfile, initialized: JsonRecord, options: SessionOptions, meta: JsonRecord | undefined,
): Promise<Pick<OpenedAcpSession, "response" | "sessionId" | "openMethod">> {
  const capabilities = asRecord(initialized.agentCapabilities);
  const sessionCapabilities = asRecord(capabilities?.sessionCapabilities);
  const baseParams = { cwd: options.cwd, ...acpAdditionalDirectories(options, initialized), mcpServers: acpMcpServersParam(options.mcpServers, initialized), ...(meta === undefined ? {} : { _meta: meta }) };
  const timeoutMs = profile.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (options.resume !== undefined) {
    const sessionId = options.resume;
    const method = savedSessionMethod(options, profile, capabilities, sessionCapabilities);
    if (profile.resumeKeepsSessionCwd === true) {
      if (!hasAcpCapability(sessionCapabilities?.list)) { throw unknownResumeCwd(sessionId, options.cwd, "listing_unavailable"); }
      await refuseResumeElsewhere(process, sessionId, options.cwd, timeoutMs, profile.normalizeListedCwd);
    }
    const params = { ...baseParams, sessionId };
    const resumed = await withAcpDeadline(process, method, openMethodTimeoutMs(profile, method), (requestOptions) => process.connection.agent.request(method, params, requestOptions))
      .catch((error: unknown) => { throw acpResumeFailure(error, method, sessionId, (native) => profile.isResumeNotFound?.(native) === true, profile.openFailure); });
    const response = responseRecord(method, resumed);
    return { response, sessionId: method === methods.agent.session.fork ? openedSessionId(method, response, sessionId) : sessionId, openMethod: method };
  }
  const method = methods.agent.session.new;
  const response = responseRecord(method, await withAcpDeadline(process, method, openMethodTimeoutMs(profile, method), (requestOptions) => process.connection.agent.request(method, baseParams, requestOptions)));
  return { response, sessionId: openedSessionId(method, response), openMethod: method };
}

export async function openAcpSession(
  process: AcpProcess, profile: AcpSessionProfile, options: SessionOptions,
  observe: AcpOpenObserver = () => {}, observers?: AcpOpenObservers, initializeStartedAt?: number,
): Promise<OpenedAcpSession> {
  // A refused login or model rejects the open as a RuntimeFailureError (failure.ts).
  const initialized = await acpOpenStep(initializeAcpConnection(process, profile, options, observe, initializeStartedAt), "open", profile.openFailure);
  return openInitializedAcpSession(process, profile, options, initialized, observe, undefined, observers);
}

/** Open/configure one session on an already initialized connection. */
export async function openInitializedAcpSession(
  process: AcpProcess, profile: AcpSessionProfile, options: SessionOptions, initialized: JsonRecord,
  observe: AcpOpenObserver = () => {}, bind: (sessionId: string) => void = () => {}, observers?: AcpOpenObservers,
): Promise<OpenedAcpSession> {
  const confirmsUpdates = profile.confirmConfigOptionUpdates === true || profile.confirmConfigOptionUpdates === "when_stale";
  if (confirmsUpdates && observers === undefined) {
    throw new Error("ACP configuration confirmation requires a session notification observer");
  }
  const updates = confirmsUpdates ? observers?.configUpdates : undefined;
  const startedAt = performance.now();
  const opened = await acpOpenStep(createOrResume(process, profile, initialized, options, profile.sessionMeta?.(options, initialized)), "open", profile.openFailure);
  bind(opened.sessionId);
  observe({ method: opened.openMethod, response: opened.response });
  await waitForOpenReadiness(process, observers?.readiness, opened.sessionId, openMethodTimeoutMs(profile, opened.openMethod), startedAt);
  const setModelResponse = await configureAcpModel(process, profile, options, opened, observe, updates);
  const configure = profile.configureSession;
  if (configure !== undefined) {
    await configure({
      request: (method, params) => withAcpDeadline(process, method, profile.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, (requestOptions) => process.connection.agent.request(method, params, requestOptions)),
      sessionId: opened.sessionId, response: opened.response, options,
    });
  }
  const sessionCapabilities = asRecord(asRecord(initialized.agentCapabilities)?.sessionCapabilities);
  return { initialized, ...opened, supportsClose: hasAcpCapability(sessionCapabilities?.close), ...(setModelResponse === undefined ? {} : { setModelResponse }) };
}
