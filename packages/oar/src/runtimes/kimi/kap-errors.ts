import type { FailureClass, ResponseBody, SessionOptions } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import { ResumeCwdError } from "../../contracts/resume-cwd-error.js";
import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";
import { SessionNotFoundError } from "../../contracts/session-not-found-error.js";
import { SessionUnavailableError } from "../../contracts/session-unavailable-error.js";
import type { JsonRecord } from "../../shared/json.js";
import { KapApiError } from "./kap-protocol.js";

export interface KapEndpoint {
  readonly origin: string;
  readonly token: string;
}

export async function ignoreRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Best-effort background fire-and-forget cleanup.
  }
}

export function classifyKapControlFailure(error: KapApiError): FailureClass | undefined {
  const code = error.code;
  if (code === 40_100 || code === 40_101 || error.httpStatus === 401) { return "auth"; }
  if (code === 42_900 || error.httpStatus === 429) { return "rate_limited"; }
  if (code === 40_001 || error.httpStatus === 400) { return "invalid_request"; }
  return undefined;
}

export function isNotFoundKapError(error: KapApiError): boolean {
  return error.code === 40_401 || error.httpStatus === 404;
}

export function isInUseKapError(error: KapApiError): boolean {
  return error.code === 40_931 || error.code === 40_901 || error.httpStatus === 409;
}

export function isNoActiveTurnKapError(error: KapApiError): boolean {
  return error.code === 40_902 || /no active turn|not running|no running turn/iu.test(error.msg);
}

function isEffortRejection(error: KapApiError): boolean {
  return /thinking|effort|reasoning/iu.test(error.msg);
}

function isModelRejection(error: KapApiError): boolean {
  return /\bmodel\b/iu.test(error.msg);
}

export function assertAdditionalDirectoriesCreatable(options: SessionOptions): void {
  if (options.resume !== undefined && (options.additionalDirectories?.length ?? 0) > 0) {
    throw new UnsupportedOptionError(
      "additionalDirectories",
      "kimi applies additionalDirectories only when creating a session; they have no effect on resume",
    );
  }
}

export function assertAuthReady(auth: JsonRecord): void {
  if (auth.models_ready === true) { return; }
  const reason = typeof auth.message === "string" && auth.message.length > 0
    ? auth.message
    : "Kimi authentication is not configured";
  throw new RuntimeFailureError("auth", reason, { credential: "missing" });
}

export function mapCreateKapError(error: unknown, options: SessionOptions): never {
  if (error instanceof KapApiError) {
    if (options.effort !== undefined && isEffortRejection(error)) {
      throw new UnsupportedOptionError("effort", error.msg);
    }
    if (options.model !== undefined && isModelRejection(error)) {
      throw new ModelConfirmationError(`Kimi rejected model "${options.model}": ${error.msg}`, {
        requested: options.model,
        reported: null,
      });
    }
  }
  throw error;
}

export function assertExistingSessionAvailable(existing: JsonRecord, resumeId: string): void {
  if (existing.archived === true) {
    throw new SessionUnavailableError(resumeId, `Kimi session ${resumeId} is archived`, {
      reason: "archived",
      method: "GET /sessions/{id}",
      native: existing,
    });
  }
}

export function throwResumeCwdMismatch(resumeId: string, savedCwd: string, cwd: string): never {
  throw new ResumeCwdError(`Kimi session ${resumeId} belongs to ${savedCwd}, not ${cwd}`, {
    sessionId: resumeId,
    requestedCwd: cwd,
    reason: "other_cwd",
    savedCwd,
  });
}

export function mapGetResumeKapError(error: unknown, resumeId: string): never {
  if (error instanceof KapApiError && isNotFoundKapError(error)) {
    throw new SessionNotFoundError(resumeId, error.msg, {
      method: "GET /sessions/{id}",
      native: error.envelope,
    });
  }
  throw error;
}

export function mapResumeKapError(error: unknown, resumeId: string, options: SessionOptions): never {
  if (error instanceof KapApiError) {
    if (isNotFoundKapError(error)) {
      throw new SessionNotFoundError(resumeId, error.msg, {
        method: "POST /sessions/{id}:resume",
        native: error.envelope,
      });
    }
    if (isInUseKapError(error)) {
      throw new SessionUnavailableError(resumeId, error.msg, {
        reason: "in_use",
        method: "POST /sessions/{id}:resume",
        native: error.envelope,
      });
    }
    return mapCreateKapError(error, options);
  }
  throw error;
}

export function verifyAgentOptions(agentState: JsonRecord, options: SessionOptions): void {
  if (options.model !== undefined) {
    const reportedModel = typeof agentState.model === "string" ? agentState.model : undefined;
    if (reportedModel !== options.model) {
      throw new ModelConfirmationError(
        `Kimi confirmed model "${reportedModel ?? "unknown"}" instead of "${options.model}"`,
        { requested: options.model, reported: reportedModel ?? null },
      );
    }
  }
  if (options.effort !== undefined) {
    const reportedThinking = typeof agentState.thinking === "string" && agentState.thinking.length > 0
      ? agentState.thinking
      : undefined;
    if (reportedThinking !== options.effort) {
      throw new UnsupportedOptionError(
        "effort",
        `Kimi confirmed thinking "${reportedThinking ?? "missing"}" instead of requested effort "${options.effort}"`,
      );
    }
  }
}

export function mapPromptControlError(error: unknown): ResponseBody {
  if (error instanceof KapApiError) {
    if (isNotFoundKapError(error)) {
      return { kind: "rejected", code: "session_not_found", reason: error.msg, native: error.envelope };
    }
    const failure = classifyKapControlFailure(error);
    return {
      kind: "rejected",
      code: "runtime_refused",
      reason: error.msg,
      native: error.envelope,
      ...(failure === undefined ? {} : { failure }),
    };
  }
  return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
}

export function mapSteerControlError(error: unknown): ResponseBody {
  if (error instanceof KapApiError) {
    if (isNoActiveTurnKapError(error)) {
      return { kind: "rejected", code: "no_active_turn", reason: error.msg, native: error.envelope };
    }
    if (isNotFoundKapError(error)) {
      return { kind: "rejected", code: "session_not_found", reason: error.msg, native: error.envelope };
    }
    return { kind: "rejected", code: "runtime_refused", reason: `not_steerable: ${error.msg}`, native: error.envelope };
  }
  return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
}

export function mapAbortControlError(error: unknown): ResponseBody {
  if (error instanceof KapApiError) {
    if (isNoActiveTurnKapError(error)) {
      return { kind: "rejected", code: "no_active_turn", reason: error.msg, native: error.envelope };
    }
    if (isNotFoundKapError(error)) {
      return { kind: "rejected", code: "session_not_found", reason: error.msg, native: error.envelope };
    }
    return { kind: "rejected", code: "runtime_refused", reason: error.msg, native: error.envelope };
  }
  return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
}
