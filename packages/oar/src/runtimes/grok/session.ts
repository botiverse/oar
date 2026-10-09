import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import type { ContextUsage, SessionOptions, TokenTotals } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { cacheParts } from "../../shared/token-totals.js";
import { grokFailureOutcome } from "./failure.js";
import { redactGrokNotification } from "../../shared/credential-redaction.js";

function authMethodIds(initialized: JsonRecord): string[] {
  return (Array.isArray(initialized.authMethods) ? initialized.authMethods : [])
    .map((method) => asRecord(method))
    .map((method) => method?.id)
    .filter((id): id is string => typeof id === "string");
}

export function selectGrokAuthMethod(initialized: JsonRecord): string | undefined {
  const ids = authMethodIds(initialized);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const preferred = asRecord(initialized._meta)?.defaultAuthMethodId;
  if (typeof preferred === "string" && ids.includes(preferred)) {
    return preferred;
  }
  return ids.includes("cached_token") ? "cached_token" : undefined;
}

export function grokInitializeMeta(options: SessionOptions): JsonRecord {
  // Grok 1.0.46 chooses override OR rules. Carry both in the override so
  // native creation and resume each receive the complete requested prompt.
  const override = options.systemPrompt === undefined || options.appendSystemPrompt === undefined
    ? options.systemPrompt
    : `${options.systemPrompt}\n\n${options.appendSystemPrompt}`;
  return {
    clientIdentifier: "oar",
    clientType: "generic",
    startupHints: {
      nonInteractive: true,
      skipGitStatus: true,
      skipProjectLayout: true,
    },
    ...(override === undefined ? {} : { systemPromptOverride: override }),
    ...(override !== undefined || options.appendSystemPrompt === undefined ? {} : { rules: options.appendSystemPrompt }),
  };
}

function firstNumber(record: JsonRecord | null, names: readonly string[]): number | null {
  for (const name of names) {
    const value = asNumber(record?.[name]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/** Grok prompt responses carry an authoritative usage snapshot in `_meta`. */
export function grokContextUsage(response: JsonRecord): ContextUsage | null {
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const meta = asRecord(response._meta);
  // `meta.totalTokens` is Grok's running context count. `meta.usage` is the
  // whole prompt's multi-call billing ledger and is not context fullness.
  const tokens = firstNumber(meta, ["totalTokens", "contextTokens"]);
  const contextWindow = firstNumber(meta, ["contextWindow", "context_window", "maxContextTokens"]);
  if (tokens === null && contextWindow === null) {
    return null;
  }
  const percent = tokens === null || contextWindow === null || contextWindow === 0
    ? null
    : Math.round((tokens / contextWindow) * 100);
  return { tokens, contextWindow, percent };
}

/**
 * The tokens one prompt answer bills: `_meta.usage` is the prompt's ledger
 * summed over its model calls (grok 1.0.25, live 2026-09-11: three one-word
 * turns billed ~16.8k input each, not a growing total; a steered turn's
 * closing answer summed its two calls). `inputTokens` includes the cached
 * reads (`cachedReadTokens` ≤ it) and, for a prompt that spawned children,
 * the children's model calls too (live-grok-c/subagent seq 159 = the four
 * `response_completed` frames 48+78+119+155, two of them the child's). The
 * turn machinery sums these per session. The same ledger's `cachedReadTokens`
 * is the cache-read part of that input and `cacheCreationTokens` the
 * cache-write part (live 1.0.25 basic answer: 1280 and 0); each is read only
 * when the ledger carries it.
 */
export function grokPromptTokens(response: JsonRecord): TokenTotals | null {
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const usage = asRecord(asRecord(response._meta)?.usage);
  const input = firstNumber(usage, ["inputTokens", "input_tokens"]);
  const output = firstNumber(usage, ["outputTokens", "output_tokens"]);
  // Both or nothing: a half ledger would invent a 0 for the missing side.
  if (usage === null || input === null || output === null) {
    return null;
  }
  return { input, output, ...cacheParts(usage, { read: "cachedReadTokens", write: "cacheCreationTokens" }) };
}

/**
 * Vendor notification methods the SDK must be told about, or it discards
 * the frame unseen. Each is recorded verbatim except MCP credential values; one that names
 * a parent/child session pair links the session graph (records.ts).
 *
 * Observed on the live wire, grok 1.0.25 (f7e67d6988e2), 2026-09-11
 * (experiments/grok-wire-tap.ts): `_x.ai/session_notification`, the vendor
 * twin of `session/update` (`{sessionId, update: {sessionUpdate}}`) carrying
 * `model_changed`, `session_summary_generated`, `tool_call_delta_chunk`,
 * `pending_interaction`, `interaction_resolved`, `response_completed`,
 * `turn_completed`, `last_turn_summary`, `background_tasks` (on resume) and
 * the sub-agent lifecycle `subagent_spawned` / `subagent_progress` /
 * `subagent_finished`; `_x.ai/sessions/changed`;
 * `_x.ai/session/prompt_complete`; and, per session start, the connection
 * housekeeping `_x.ai/queue/changed`, `_x.ai/models/update`,
 * `_x.ai/settings/update`, `_x.ai/announcements/update`,
 * `_x.ai/mcp/servers_updated`, `_x.ai/mcp/init_progress`,
 * `_x.ai/mcp/server_status`, `_x.ai/mcp_initialized`, all of which the tap
 * showed on the wire but missing from the stream until listed here.
 *
 * Still [sym] only (in the binary's symbol table, never on a live wire):
 * `_x.ai/session/update`, `_x.ai/task_backgrounded`, `_x.ai/task_completed`,
 * `_x.ai/session/usage`. Kept registered: an unlisted name is a dropped frame.
 */
export const GROK_EXTENSION_NOTIFICATIONS: readonly string[] = [
  // live 2026-09-11
  "_x.ai/session_notification",
  "_x.ai/sessions/changed",
  "_x.ai/session/prompt_complete",
  "_x.ai/queue/changed",
  "_x.ai/models/update",
  "_x.ai/settings/update",
  "_x.ai/announcements/update",
  "_x.ai/mcp/servers_updated",
  "_x.ai/mcp/init_progress",
  "_x.ai/mcp/server_status",
  "_x.ai/mcp_initialized",
  // [sym] only
  "_x.ai/session/update",
  "_x.ai/task_backgrounded",
  "_x.ai/task_completed",
  "_x.ai/session/usage",
];

export const grokRefusedSessionOptions: RefusedSessionOptions = {
  serviceTier: "grok exposes no verified per-session service-tier setting and readback",
  disallowedTools: "grok agent stdio does not forward the CLI tool denylist; supplying an agent profile would replace the user's selected harness rather than overlay its tools",
};

export const grokAcpProfile: AcpSessionProfile = {
  args: ["agent", "--always-approve", "--no-leader", "stdio"],
  // `grok agent [OPTIONS] stdio [OPTIONS]`: agent options (--model,
  // --agent-profile, --plugin-dir, ...) go before `stdio`, which itself
  // takes only --debug and --leader-socket.
  withLaunchArgs: (args, launchArgs) => [...args.slice(0, -1), ...launchArgs, ...args.slice(-1)],
  // Native children are independent ACP sessions on the same connection
  // (attribution tier #3, docs/spec/attribution.md): recorded under their own
  // session id, linked in the graph when a lifecycle notification says so.
  // Images despite `initialize` saying `promptCapabilities.image: false`: grok 1.0.44
  // hands an ACP image block to the model (live, docs/runtimes/grok.md).
  capabilities: { queue: { durable: false }, attribution: "nested", images: true },
  extensionNotifications: GROK_EXTENSION_NOTIFICATIONS,
  redactExtensionNotification: redactGrokNotification,
  failureOutcome: grokFailureOutcome,
  terminalShellCommand: true,
  initializeMeta: grokInitializeMeta,
  validateOptions: (options) => {
    refuseSessionOptions(grokRefusedSessionOptions, options);
    if (options.resume !== undefined && options.appendSystemPrompt !== undefined && options.systemPrompt === undefined) {
      throw new UnsupportedOptionError("appendSystemPrompt", "grok does not reapply rules when resuming a session (observed on 1.0.46)");
    }
  },
  sessionMeta: () => ({ yoloMode: true }),
  selectAuthMethod: selectGrokAuthMethod,
  // `_meta.sendNow` is not an injection: grok answers the running prompt
  // `cancelled` (`cancelTrigger: "send_now"`, live 1.0.25) and starts a fresh
  // model turn that re-issued the interrupted tool calls; both answers fold
  // into the one oar turn (turns.ts).
  steerParams: () => ({ _meta: { sendNow: true } }),
  promptContextUsage: grokContextUsage,
  promptTokenUsage: grokPromptTokens,
};

export const grokSession = acpSession(grokAcpProfile);
