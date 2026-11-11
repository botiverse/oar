import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";
import type { FailureClass, ResponseBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/*
 * Codex's refusals in its own words and codes, read into OAR's types
 * (docs/runtimes/codex.md#refusals). Observed on codex-cli 0.118.0 to 0.135.0
 * and 0.154.0 driving `codex app-server` directly; the turn/start paths are
 * from the 0.167.0 source (app-server/src/request_processors/turn_processor.rs,
 * error_code.rs, config_errors.rs).
 */

/** The version in codex's `initialize` `userAgent` (`<client>/<version> (...)`), or null. */
export function codexVersion(reply: JsonRecord): string | null {
  const agent = reply.userAgent;
  const version = typeof agent === "string" ? /^[^/\s]+\/(\d+\.\d+\.\d+\S*)/u.exec(agent)?.[1] : undefined;
  return version ?? null;
}

/** What OAR needs from codex that an older release lacks, and the first release that has it. */
const NEEDS: Readonly<Record<string, { readonly since: string; readonly purpose: string }>> = {
  "thread/settings/update": { since: "0.133.0", purpose: "to set the effort of a resumed thread" },
};

/** Service tiers codex accepts from 0.129.0; earlier releases know only `fast` and `flex`. */
const TIERS_SINCE_0_129 = new Set(["default", "priority"]);

function nativeMessage(native: JsonRecord | null): string | null {
  return native?.code === -32_600 && typeof native.message === "string" ? native.message : null;
}

function outdated(version: string | null, what: string, since: string, cause: JsonRecord): RuntimeFailureError {
  return new RuntimeFailureError("invalid_request",
    `Codex ${version ?? "(version unreported)"} ${what}; update Codex to ${since} or newer`, { code: "runtime_outdated", cause });
}

/**
 * The typed error for a request codex refused while OAR opened the session, or
 * null to keep the plain one. An older codex refuses a method it does not know
 * with -32600 `Invalid request: unknown variant \`<method>\`, expected one of
 * ...`, and a service tier before 0.129.0 with -32600 `Invalid request: unknown
 * variant \`default\`, expected \`fast\` or \`flex\``: both are
 * `runtime_outdated`. An unreadable `config.toml` is -32600 `failed to load
 * configuration: <path>:<line>:<column>: <detail>` on thread/start and
 * thread/resume (codex starts on its defaults and refuses only there):
 * `runtime_config_invalid`, with codex's words.
 */
export function codexOpenFailure(method: string, native: JsonRecord | null, context: { readonly version: string | null; readonly serviceTier?: string | undefined }): RuntimeFailureError | null {
  const message = nativeMessage(native);
  if (native === null || message === null) { return null; }
  const cause = { method, native };
  const need = Object.hasOwn(NEEDS, method) ? NEEDS[method] : undefined;
  if (need !== undefined && message.startsWith(`Invalid request: unknown variant \`${method}\``)) {
    return outdated(context.version, `does not know ${method}, which OAR needs ${need.purpose}`, need.since, cause);
  }
  const tier = context.serviceTier;
  if (tier !== undefined && TIERS_SINCE_0_129.has(tier) && message.startsWith(`Invalid request: unknown variant \`${tier}\`, expected \`fast\` or \`flex\``)) {
    return outdated(context.version, `does not accept serviceTier ${tier} (it accepts fast and flex)`, "0.129.0", cause);
  }
  if (message.startsWith("failed to load configuration: ")) {
    return new RuntimeFailureError("invalid_request", `codex ${method} failed: ${message}`, { code: "runtime_config_invalid", cause });
  }
  return null;
}

/**
 * A control (turn/start, turn/steer, thread/queue/add) codex refused, as
 * the rejection to record. `thread not found: <id>` (-32600) means this
 * process no longer has the session: `session_not_found`. Otherwise
 * `runtime_refused`, with a `failure` where codex's code or data says one:
 * -32602 with `data.input_error_code: "input_too_large"` (its input limit),
 * -32001 (its request queue is full: `overloaded`), and -32600 for an
 * unreadable configuration or a model provider the thread cannot use
 * (`data.type: modelProvider...`): `invalid_request`. Any other refusal keeps
 * codex's words without a class.
 */
export function codexControlRefusal(reason: string, native: JsonRecord | undefined): ResponseBody {
  const record = native ?? null;
  const base = { kind: "rejected", reason, ...(native === undefined ? {} : { native }) } as const;
  const message = typeof record?.message === "string" ? record.message : "";
  const data = asRecord(record?.data);
  if (record?.code === -32_600 && message.startsWith("thread not found: ")) {
    return { ...base, code: "session_not_found" };
  }
  const failure = controlFailure(record?.code, message, data);
  return { ...base, code: "runtime_refused", ...(failure === null ? {} : { failure }) };
}

function controlFailure(code: unknown, message: string, data: JsonRecord | null): FailureClass | null {
  if (code === -32_602 && data?.input_error_code === "input_too_large") { return "input_too_large"; }
  if (code === -32_001) { return "overloaded"; }
  const provider = typeof data?.type === "string" && data.type.startsWith("modelProvider");
  return code === -32_600 && (message.startsWith("failed to load configuration: ") || provider) ? "invalid_request" : null;
}
