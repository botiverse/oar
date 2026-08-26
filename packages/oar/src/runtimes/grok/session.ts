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

export const grokAcpProfile: AcpSessionProfile = {
  args: ["agent", "--always-approve", "--no-leader", "stdio"],
  terminalShellCommand: true,
  initializeMeta: grokInitializeMeta,
  sessionMeta: () => ({ yoloMode: true }),
  selectAuthMethod: selectGrokAuthMethod,
  steerParams: () => ({ _meta: { sendNow: true } }),
  promptContextUsage: grokContextUsage,
};

export const grokSession = acpSession(grokAcpProfile);
