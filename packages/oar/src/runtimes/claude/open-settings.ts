import { SessionNotFoundError } from "../../contracts/session-not-found-error.js";
import { sessionCredentialRedactor } from "../../shared/credential-redactor.js";
import { randomUUID } from "node:crypto";
import type { SessionOptions } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

import { nativeErrorCause } from "../../shared/native-error.js";
import type { ClaudeProcess } from "./launch.js";
import { CLAUDE_EFFORT_READBACK_MS, claudeControlResponseId, claudeEffortRefusal, claudeSettingsRequest } from "./effort.js";
import { claudeServiceTierRefusal } from "./service-tier.js";
import { claudeUsageBaseline, type ClaudeUsageBaseline } from "./token-usage.js";

type Method = "get_settings" | "initialize" | "get_usage";
type Option = "effort" | "serviceTier" | "resume";

function failedInitialization(message: JsonRecord): boolean {
  return message.type === "result" && message.subtype === "error_during_execution";
}

function refusalFor(answer: JsonRecord | Error, option: Option, requested: string, options: SessionOptions): string | null {
  if (answer instanceof Error) { return `${answer.message}, so ${option} ${requested} cannot be confirmed`; }
  if (failedInitialization(answer)) {
    const errors = Array.isArray(answer.errors) ? answer.errors.filter((error): error is string => typeof error === "string") : [];
    return errors.join("\n") || "claude initialization failed (result/error_during_execution)";
  }
  if (option === "effort") { return claudeEffortRefusal(requested, answer); }
  if (option === "serviceTier") { return claudeServiceTierRefusal(requested, answer); }
  const response = asRecord(answer.response);
  if (response?.subtype !== "success") {
    return `claude could not resume ${requested} (initialize: ${typeof response?.error === "string" ? response.error : "no success answer"})`;
  }
  return options.serviceTier === undefined ? null : claudeServiceTierRefusal(options.serviceTier, answer);
}

/** Successful readbacks contain private configuration or account details, never error diagnostics. */
function failureNative(answer: JsonRecord | Error): JsonRecord | undefined {
  if (answer instanceof Error) { return undefined; }
  if (failedInitialization(answer)) { return answer; }
  const response = asRecord(answer.response);
  return response?.subtype === "error" ? response : undefined;
}

interface Pending {
  readonly id: string;
  readonly method: Method;
  readonly settle: (answer: JsonRecord | Error) => void;
}
interface OpenSettings {
  /** True for private readbacks, whose account details and configuration must not enter records. */
  consume(message: JsonRecord): boolean;
  exited(code: number | null): void;
  confirm(options: SessionOptions): Promise<void>;
  /**
   * A resume's token baseline: claude's `get_usage` `session.model_usage`,
   * the running total the resumed process continues (token-usage.ts). Never
   * throws or stops the process: a timeout, an exit, an error answer or one
   * without session totals is an unknown baseline. The answer also carries
   * account data (subscription, rate-limit windows), so it stays private
   * like the others.
   */
  usageBaseline(): Promise<ClaudeUsageBaseline>;
}

/** Bounded native readbacks at open, consumed before the ordinary projection stream. */
export function claudeOpenSettings(child: ClaudeProcess): OpenSettings {
  let pending: Pending | null = null;
  const privateIds = new Set<string>();
  const lifetime: { exited: boolean; code: number | null; failure: JsonRecord | null } = { exited: false, code: null, failure: null };
  let opening = true;
  const exitError = (method: Method): Error => new Error(`claude exited (code ${String(lifetime.code)}) before answering ${method}`);
  const confirm = async (method: Method, option: Option, options: SessionOptions): Promise<void> => {
    const requested = options[option];
    if (requested === undefined) { return; }
    const { redact } = sessionCredentialRedactor(options);
    const { promise, resolve } = Promise.withResolvers<JsonRecord | Error>();
    const id = `oar-${option}-${randomUUID()}`;
    pending = { id, method, settle: resolve };
    privateIds.add(id);
    const timer = setTimeout(() => { resolve(new Error(`claude did not answer ${method} within ${String(CLAUDE_EFFORT_READBACK_MS)} ms`)); }, CLAUDE_EFFORT_READBACK_MS);
    try {
      if (lifetime.failure !== null) { resolve(lifetime.failure); }
      else if (lifetime.exited) { resolve(exitError(method)); }
      else { child.write(method === "get_settings" ? claudeSettingsRequest(id) : `${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: method } })}\n`); }
      const answer = await promise;
      const refusal = refusalFor(answer, option, requested, options);
      if (refusal !== null) {
        const native = failureNative(answer);
        const cause = native === undefined ? undefined : nativeErrorCause(method, native, redact);
        // Only a missing-resume result that won the initialize readback.
        // Prose is the last resort, pinned by claude-missing-resume.json.
        if (option === "resume" && method === "initialize" && native !== undefined && failedInitialization(native)
          && Array.isArray(native.errors) && typeof native.errors[0] === "string"
          && native.errors[0].startsWith("No conversation found with session ID") && cause !== undefined) {
          throw new SessionNotFoundError(requested, redact(refusal), cause);
        }
        throw new Error(redact(refusal), cause === undefined ? undefined : { cause });
      }
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    } finally {
      clearTimeout(timer);
      pending = null;
    }
  };
  return {
    consume(message) {
      if (opening && failedInitialization(message)) {
        lifetime.failure = message;
        pending?.settle(message);
      }
      const id = claudeControlResponseId(message);
      if (pending !== null && id === pending.id) { pending.settle(message); }
      return id !== null && privateIds.has(id);
    },
    exited(code) {
      lifetime.exited = true;
      lifetime.code = code;
      if (pending !== null) { pending.settle(exitError(pending.method)); }
    },
    async usageBaseline() {
      if (lifetime.exited) { return { kind: "unknown" }; }
      const { promise, resolve } = Promise.withResolvers<JsonRecord | Error>();
      const id = `oar-usage-${randomUUID()}`;
      pending = { id, method: "get_usage", settle: resolve };
      privateIds.add(id);
      const timer = setTimeout(() => { resolve(new Error(`claude did not answer get_usage within ${String(CLAUDE_EFFORT_READBACK_MS)} ms`)); }, CLAUDE_EFFORT_READBACK_MS);
      try {
        // skip_behaviors: the answer's local-transcript scan is not needed.
        child.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "get_usage", skip_behaviors: true } })}\n`);
        return claudeUsageBaseline(await promise);
      } finally {
        clearTimeout(timer);
        pending = null;
      }
    },
    async confirm(options) {
      try {
        // Missing resumes report a result error and exit without an initialize
        // answer. Confirm that handshake before any settings readback.
        if (options.resume !== undefined) { await confirm("initialize", "resume", options); }
        if (options.effort !== undefined) { await confirm("get_settings", "effort", options); }
        if (options.serviceTier !== undefined && options.resume === undefined) { await confirm("initialize", "serviceTier", options); }
      } finally {
        opening = false;
        lifetime.failure = null;
      }
    },
  };
}
