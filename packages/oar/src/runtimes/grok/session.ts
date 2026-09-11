import type { ContextUsage, SessionOptions, TokenTotals } from "../../contracts/session.js";
import { acpSession, type AcpSessionProfile } from "../../shared/acp/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";

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
  return {
    clientIdentifier: "oar",
    clientType: "generic",
    startupHints: {
      nonInteractive: true,
      skipGitStatus: true,
      skipProjectLayout: true,
    },
    ...(options.systemPrompt === undefined ? {} : { systemPromptOverride: options.systemPrompt }),
    ...(options.appendSystemPrompt === undefined ? {} : { rules: options.appendSystemPrompt }),
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
 * turn machinery sums these per session.
 */
export function grokPromptTokens(response: JsonRecord): TokenTotals | null {
  // oxlint-disable-next-line eslint/no-underscore-dangle -- `_meta` is the ACP extension envelope.
  const usage = asRecord(asRecord(response._meta)?.usage);
  const input = firstNumber(usage, ["inputTokens", "input_tokens"]);
  const output = firstNumber(usage, ["outputTokens", "output_tokens"]);
  // Both or nothing: a half ledger would invent a 0 for the missing side.
  if (input === null || output === null) {
    return null;
  }
  return { input, output };
}

/**
 * Vendor notification methods the SDK must be told about, or it discards
 * the frame unseen. Registered so each is recorded verbatim; one that names
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

export const grokAcpProfile: AcpSessionProfile = {
  args: ["agent", "--always-approve", "--no-leader", "stdio"],
  // Native children are independent ACP sessions on the same connection
  // (attribution tier #3, docs/spec/attribution.md): recorded under their own
  // session id, linked in the graph when a lifecycle notification says so.
  capabilities: { steer: true, queue: { durable: false }, attribution: "nested" },
  extensionNotifications: GROK_EXTENSION_NOTIFICATIONS,
  terminalShellCommand: true,
  initializeMeta: grokInitializeMeta,
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
