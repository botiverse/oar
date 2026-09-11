import type { ContextUsage, SessionOptions } from "../../contracts/session.js";
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
 * Vendor notification methods seen in the grok 1.0.13 binary's symbol table
 * ([sym] only — not yet observed on a live wire): child-session lifecycle,
 * background tasks, prompt completion and usage. Registered so the SDK routes
 * them to oar instead of discarding them; each is recorded verbatim, and one
 * that names a parent/child session pair links the session graph.
 */
export const GROK_EXTENSION_NOTIFICATIONS: readonly string[] = [
  "_x.ai/session/update",
  "_x.ai/session_notification",
  "_x.ai/sessions/changed",
  "_x.ai/task_backgrounded",
  "_x.ai/task_completed",
  "_x.ai/session/prompt_complete",
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
  steerParams: () => ({ _meta: { sendNow: true } }),
  promptContextUsage: grokContextUsage,
};

export const grokSession = acpSession(grokAcpProfile);
