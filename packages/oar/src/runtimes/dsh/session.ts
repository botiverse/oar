/* oxlint-disable import/max-dependencies -- Native launch, controls, projection and the credential boundary meet here. */
/* oxlint-disable eslint/require-await -- Session controls return kernel promises directly. */
import { sessionExitReason } from "../../shared/executable/reported-stderr.js";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import { readExecutableVersion } from "../../shared/executable/index.js";
import { dshVersionRefusal } from "./version.js";
import { randomUUID } from "node:crypto";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { ResumeCwdError } from "../../contracts/resume-cwd-error.js";
import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import { SessionNotFoundError } from "../../contracts/session-not-found-error.js";
import type { ResponseBody, Session, SessionOptions, StartSession } from "../../contracts/session.js";
import { createAbortFallback } from "../../shared/abort-fallback.js";
import { appendCleanupFailure, cleanupFailureReason } from "../../shared/executable/process-cleanup.js";
import { withInputImages, type LoadedImage } from "../../shared/input-images.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { sessionFileLocator } from "../../shared/native-session-file.js";
import { sameDirectory } from "../../shared/same-directory.js";
import { checkSessionName, refuseSessionOptions } from "../../shared/session-options.js";
import { withSessionCredentials, type SessionCredentials } from "../../shared/session-credentials.js";
import { dshCompaction } from "./compaction.js";
import { DshCommandError, dshControl, isDshExitedError, type DshControl } from "./control.js";
import { dshEnvironment, launchDsh } from "./launch.js";
import { isBackgroundShellJob } from "./jobs.js";
import { dshGoalControl } from "./goal.js";
import { dshMcpConfigs } from "./mcp.js";
import { checkDshProvider, dshProviderAudit, dshProviderPatchRow } from "./provider.js";
import { dshAgentOptions, dshDirectoryRefusal, dshRefusedSessionOptions, dshSessionLogUploadRefusal, dshSupportsNativeSessionFile, type DshAgentOptions } from "./options.js";
import { dshOpenedFrame, foldDsh, initialDshProjection } from "./projection.js";

const OPEN_TIMEOUT_MS = 60_000;
const DISPOSE_TIMEOUT_MS = 8000;

/** Typed opening refusals from native evidence; anything else keeps its own message and native error as cause. */
function openFailure(error: unknown, sessionId: string, resuming: boolean): Error {
  if (!(error instanceof DshCommandError)) { return error instanceof Error ? error : new Error(String(error)); }
  if (error.native.name === "SessionPersistenceNotFoundError") {
    return new SessionNotFoundError(sessionId, `DSH has no saved session ${sessionId}`, { method: "sessionPersistence.open", native: error.native });
  }
  if ((error.code === "native_method_unavailable" || error.code === "option_not_applied") && (error.capability === "name" || error.capability === "disallowedTools" || error.capability === "additionalDirectories" || error.capability === "sessionLogUpload" || error.capability === "dshProvider")) {
    return new UnsupportedOptionError(error.capability, error.message);
  }
  if (error.code === "prompt_not_applied" && (error.capability === "systemPrompt" || error.capability === "appendSystemPrompt")) {
    return new UnsupportedOptionError(error.capability, error.message);
  }
  if (error.code === "native_method_unavailable") {
    if (error.capability === "confirming a reasoning effort") { return new UnsupportedOptionError("effort", error.message); }
    if (error.capability === "systemPrompt" || error.capability === "appendSystemPrompt") { return new UnsupportedOptionError(error.capability, error.message); }
    if (error.capability === "session MCP") { return new UnsupportedOptionError("mcpServers", error.message); }
    if (error.capability === "goals") { return new UnsupportedOptionError(error.capability, error.message); }
    if (error.capability === "confirming a model") { return new UnsupportedOptionError("model", error.message); }
    return resuming ? new UnsupportedOptionError("resume", error.message) : new RuntimeFailureError("invalid_request", error.message, { cause: error });
  }
  if (error.code === "UNSUPPORTED_REASONING_EFFORT") { return new UnsupportedOptionError("effort", error.message); }
  if (error.code === "UNKNOWN_MODEL" || error.code === "NO_ADAPTER") { return new RuntimeFailureError("model_unavailable", error.message, { cause: error }); }
  return error;
}

/** Where the runtime already reports its selection, a request it did not take is refused rather than run on another route. */
function refuseUnappliedRoute(opened: JsonRecord, requested: DshAgentOptions, requestedModel: string | undefined): void {
  const reported = asRecord(opened.model);
  if (reported === null) { return; }
  if (requestedModel !== undefined && requested.provider !== undefined && (reported.provider !== requested.provider || reported.model !== requested.model)) {
    throw new ModelConfirmationError(`DSH did not apply model ${requested.provider}/${String(requested.model)}: it reports ${String(reported.provider)}/${String(reported.model)}`, {
      requested: requestedModel,
      reported: typeof reported.provider === "string" && typeof reported.model === "string" ? `${reported.provider}/${reported.model}` : null,
    });
  }
  if (requested.reasoningEffort !== undefined && reported.reasoningEffort !== requested.reasoningEffort) {
    throw new UnsupportedOptionError("effort", `DSH did not apply effort ${requested.reasoningEffort}: it reports ${String(reported.reasoningEffort)}`);
  }
}

/** Native resume has no cwd override: the session runs where it was saved, whatever process cwd it resumes from. */
async function savedRoute(control: DshControl, sessionId: string, cwd: string): Promise<JsonRecord | undefined> {
  const saved = await control.request("peek", { sessionId }, OPEN_TIMEOUT_MS);
  const savedCwd = asRecord(saved.header)?.cwd;
  if (typeof savedCwd !== "string") { throw new UnsupportedOptionError("resume", `DSH's saved session ${sessionId} names no working directory to compare`); }
  if (!sameDirectory(savedCwd, cwd)) {
    throw new ResumeCwdError(`session ${sessionId} lives in ${savedCwd} and DSH resumes it only there; the resume names ${cwd}`, {
      sessionId, requestedCwd: cwd, reason: "other_cwd", savedCwd,
    });
  }
  return asRecord(saved.route) ?? undefined;
}

function refusalOf(error: unknown): ResponseBody {
  if (isDshExitedError(error)) { return { kind: "rejected", code: "runtime_exited", reason: error.message }; }
  if (!(error instanceof DshCommandError)) { return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) }; }
  if (error.code === "busy") { return { kind: "rejected", code: "busy", reason: "busy" }; }
  if (error.code === "no_active_turn") { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
  if (error.code === "native_method_unavailable" || error.code === "unsupported_task" || error.code === "image_unsupported") { return { kind: "rejected", code: "unsupported", reason: error.message, native: error.native }; }
  return { kind: "rejected", code: "runtime_refused", reason: error.message, native: error.native };
}

const inputFields = (text: string, inputId: string | undefined, images: readonly LoadedImage[]): JsonRecord => ({
  text, ...(inputId === undefined ? {} : { inputId }),
  ...(images.length === 0 ? {} : { images: images.map(({ data, mediaType }) => ({ data, mediaType })) }),
});

async function open(command: string, options: SessionOptions, env: NodeJS.ProcessEnv, credentials: SessionCredentials, mcpConfigs: readonly JsonRecord[], supportsSessionFile: boolean): Promise<Session> {
  const sessionId = options.resume ?? randomUUID();
  const agentOptions = dshAgentOptions(options);
  // The route this session asks for, as DSH names it: the request `refuseUnappliedRoute` reads back.
  const requestedModel = agentOptions.provider === undefined || agentOptions.model === undefined ? options.model : `${agentOptions.provider}/${agentOptions.model}`;
  const provider = options.dshProvider === undefined ? undefined : { patch: dshProviderPatchRow(options.dshProvider), audit: dshProviderAudit(options.dshProvider) };
  const kernel = credentials.kernel(sessionId);
  let projection = initialDshProjection(sessionId);
  const { child, directory, profileLoaded } = await launchDsh(command, options.cwd, env, {
    disableSessionLogUpload: options.sessionLogUpload === "off",
    ...(provider === undefined ? {} : { provider }),
  });
  const fallback = createAbortFallback(() => { child.kill(); });
  let exited = false;
  let hasSessionFileStat = false;
  let sessionFilePath: string | undefined = undefined;
  const rememberSessionFile = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) { sessionFilePath = value; }
  };
  const control = dshControl(child, (message) => {
    const { state, frame } = foldDsh(projection, message);
    projection = state;
    if (frame.sessionId === undefined && frame.body.events.some((event) => event.kind === "turn_ended")) {
      fallback.clear();
      if (hasSessionFileStat && !exited) {
        void (async (): Promise<void> => {
          try {
            const answer = await control.request("sessionFile", { sessionId, flush: false });
            rememberSessionFile(answer.path);
          } catch {
            // Best-effort refresh before unexpected exit; explicit calls still query or report errors.
          }
        })();
      }
    }
    kernel.frame(frame.body, frame.sessionId === undefined ? undefined : { sessionId: frame.sessionId });
  }, credentials.redact, profileLoaded);
  child.onExit((code, reason) => {
    exited = true;
    fallback.clear();
    kernel.processExited(code, sessionExitReason(child, reason, credentials.redact));
  });
  const fields = { sessionId, agentOptions: { ...agentOptions },
    ...(options.additionalDirectories === undefined ? {} : { additionalDirectories: options.additionalDirectories }),
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: options.appendSystemPrompt }),
  };
  let opened: JsonRecord = {};
  try {
    await control.ready;
    if (mcpConfigs.length > 0) { await control.request("mountMcp", { servers: mcpConfigs }, OPEN_TIMEOUT_MS); }
    if (options.goals === true) { await control.request("goalConfirm"); }
    if (options.resume === undefined) { opened = await control.request("open", { ...fields, cwd: options.cwd }, OPEN_TIMEOUT_MS); }
    else {
      const route = await savedRoute(control, sessionId, options.cwd);
      opened = await control.request("resume", { ...fields, ...(route === undefined ? {} : { route }) }, OPEN_TIMEOUT_MS);
    }
    refuseUnappliedRoute(opened, agentOptions, requestedModel);
    if (opened.sessionId !== sessionId) { throw new Error(`DSH opened ${String(opened.sessionId)}, not ${sessionId}`); }
    if (options.name !== undefined) { await control.request("name", { sessionId, name: options.name, resuming: options.resume !== undefined }, OPEN_TIMEOUT_MS); }
  } catch (error) {
    child.kill();
    await child.exited;
    throw appendCleanupFailure(openFailure(error, sessionId, options.resume !== undefined), cleanupFailureReason(child.diagnostics().cleanup));
  }
  kernel.frame(dshOpenedFrame(opened));
  hasSessionFileStat = supportsSessionFile && opened.sessionFileStat === true;
  rememberSessionFile(opened.sessionFile);
  const nativeSessionFile = hasSessionFileStat ? async (): Promise<string | null> => {
    if (!exited) {
      try {
        const answer = await control.request("sessionFile", { sessionId, flush: true });
        rememberSessionFile(answer.path);
      } catch (error) {
        if (!isDshExitedError(error)) { throw error; }
      }
    }
    return sessionFileLocator(sessionFilePath, credentials.redact)();
  } : undefined;

  const capabilities = { queue: { durable: false }, attribution: "nested", images: Array.isArray(opened.imageTypes) && opened.imageTypes.length > 0 } as const;
  const methods = asRecord(opened.methods) ?? {};
  const inboxMethods = asRecord(opened.inboxMethods) ?? {};
  const jobMethods = asRecord(opened.jobMethods);
  const send = async (method: string, payload: JsonRecord): Promise<ResponseBody> => {
    try { return { kind: "accepted", native: await control.request(method, { sessionId, ...payload }) }; }
    catch (error) { return kernel.unreachable() ?? refusalOf(error); }
  };
  let prompting = false;
  const active = (): boolean => projection.sessions[sessionId]?.turnOpen === true;

  const compaction = opened.compact === true ? dshCompaction(kernel, control, () => active() || prompting || (projection.sessions[sessionId]?.nextTurn.length ?? 0) > 0) : undefined;
  const compactBusy = { kind: "rejected", code: "busy", reason: "DSH is compacting this session" } as const;

  return credentials.seal({
    id: sessionId, capabilities, resources: child.resources,
    ...(nativeSessionFile === undefined ? {} : { nativeSessionFile }),
    ...(compaction === undefined ? {} : { compact: compaction.compact }),
    ...(options.goals === true ? { goal: dshGoalControl(kernel, control, sessionId, refusalOf) } : {}),
    prompt: async (text, inputOptions) => kernel.control({ kind: "prompt", input: text, ...inputOptions }, async () => {
      if (compaction?.busy() === true) { return compactBusy; }
      if (active() || prompting) { return { kind: "rejected", code: "busy", reason: "busy" }; }
      return withInputImages(capabilities, inputOptions?.images, async images => {
        prompting = true;
        try { return await send("prompt", inputFields(text, inputOptions?.inputId, images)); }
        finally { prompting = false; }
      });
    }),
    // A control the runtime cannot do is an absent member; `dsh/opened` keeps the inventory that says why.
    ...(methods.steer === true ? {
      steer: async (text, inputOptions) => kernel.control({ kind: "steer", input: text, ...inputOptions }, async () => {
        if (compaction?.busy() === true) { return compactBusy; }
        if (!active() && !prompting) { return { kind: "rejected", code: "no_active_turn", reason: "no active turn" }; }
        return withInputImages(capabilities, inputOptions?.images, async images => send("steer", inputFields(text, inputOptions?.inputId, images)));
      }),
    } : {}),
    queue: async (text, inputOptions) => kernel.control({ kind: "queue", input: text, ...inputOptions }, async () =>
      compaction?.busy() === true ? compactBusy : withInputImages(capabilities, inputOptions?.images, async images => send("queue", inputFields(text, inputOptions?.inputId, images)))),
    ...(inboxMethods.remove === true ? {
      withdraw: async (inputId) => kernel.control({ kind: "withdraw", inputId }, async () => {
        const answer = await send("withdraw", { messageId: inputId });
        return answer.kind === "accepted" && asRecord(answer.native)?.removed === false
          ? { kind: "rejected", code: "not_queued", reason: "no held input with this inputId is waiting" } : answer;
      }),
    } : {}),
    ...(jobMethods?.get === true && jobMethods.kill === true && jobMethods.wait === true ? {
      stopTask: async (taskId) => kernel.control({ kind: "stop_task", taskId }, async () =>
        isBackgroundShellJob(kernel.records(), sessionId, taskId) ? send("stopTask", { taskId })
          : { kind: "rejected", code: "unsupported", reason: "DSH stops only this session's explicitly backgrounded shell jobs" }),
    } : {}),
    abort: async () => kernel.control({ kind: "abort" }, async () => {
      if (compaction?.busy() === true) { return compaction.admitted() ? send("cancelCompaction", {}) : compactBusy; }
      const disarm = fallback.arm();
      const answer = await send("cancel", {});
      if (answer.kind !== "accepted") { disarm(); }
      return answer;
    }),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(), graph: () => kernel.graph(),
    dispose: async () => {
      await kernel.dispose(async () => {
        // Native disposal records its own turn end and flushes the log; the
        // process owner then bounds shutdown and removes anything left.
        try {
          const disposed = await control.request("dispose", {}, DISPOSE_TIMEOUT_MS);
          rememberSessionFile(asRecord(disposed.sessionFiles)?.[sessionId]);
        }
        catch (error) {
          kernel.frame({ type: "dsh/dispose-failed", native: error instanceof DshCommandError ? error.native : { message: String(error) }, events: [] });
        }
        child.kill();
        await child.exited;
        directory.remove();
      }, () => { directory.remove(); });
    },
  });
}

/** One owned DSH process per session, reached through a private bridge plugin. */
export const dshSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  refuseSessionOptions(dshRefusedSessionOptions, options);
  checkSessionName(options);
  // Checked before spawning anything: both refusals name what they refuse.
  if (options.dshProvider !== undefined) { checkDshProvider(options.dshProvider); }
  dshAgentOptions(options);
  const mcpConfigs = dshMcpConfigs(options.mcpServers, options.cwd);
  if (installation.via !== "executable") { throw new Error("DSH requires its executable installation"); }
  const env = dshEnvironment(options.env);
  // A floor refusal names the real version, before anything starts.
  const version = installation.version ?? await readExecutableVersion(installation.command, 15_000, undefined, env);
  refuseSessionOptions(dshSessionLogUploadRefusal(version), options);
  const refusal = dshVersionRefusal(version);
  if (refusal !== null) { throw new RuntimeFailureError("invalid_request", refusal); }
  refuseSessionOptions(dshDirectoryRefusal(version), options);
  const directories = resolvedAdditionalDirectories(options);
  return open(installation.command, directories.length === 0 ? options : { ...options, additionalDirectories: directories }, env, credentials, mcpConfigs, dshSupportsNativeSessionFile(version) === true);
});
