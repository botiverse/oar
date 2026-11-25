import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { hermesInstallation } from "./installation.js";
import { hermesInstallationRefusals, hermesMeasuredMcpCredentials } from "./mcp-credentials.js";
import { hermesRefusedSessionOptions } from "./options.js";

const NO_MANUAL_COMPACTION = {
  kind: "unsupported" as const,
  reason: "Hermes exposes `/compress` in its ACP command list, but no structured completion or attribution contract has been verified.",
};

export const hermesRuntime = defineRuntime({
  id: "hermes",
  // `initialize` advertises image prompts and the gateway publishes
  // `usage_update` from its session stats. Turns and children stay opaque;
  // the ACP surface exposes no single-task stop.
  sessionCapabilities: (installation) => ({
    taskEventTypes: [],
    steer: false,
    stopTask: false,
    // Measured on 0.23.3; opened sessions still consult initialize.promptCapabilities.
    ...(hermesMeasuredMcpCredentials(installation) ? { images: true } : {}),
    contextUsage: { tokens: true, contextWindow: true },
    // Stdio only: `initialize` declares no `mcpCapabilities.http`. A stdio
    // entry with `env` attaches only on the release whose credential handling
    // OAR measured (mcp-credentials.ts).
    mcpTransports: ["stdio"],
    mcpServerCredentialsVerified: hermesMeasuredMcpCredentials(installation),
    manualCompaction: NO_MANUAL_COMPACTION,
    refusedSessionOptions: hermesInstallationRefusals(installation),
  }),
  manualCompaction: NO_MANUAL_COMPACTION,
  brand: runtimeBrands.hermes,
  // Hermes owns provider authentication in its profile: API keys in
  // `$HERMES_HOME/.env`, OAuth/account credentials in `auth.json`, and the
  // selected provider/model (which may hold a key) in `config.yaml`.
  credentials: {
    scope: "per_provider",
    management: "native",
    env: [
      { name: "OPENROUTER_API_KEY", purpose: "api_key", secret: true, provider: "openrouter", field: "apiKey" },
      { name: "OPENAI_API_KEY", purpose: "api_key", secret: true, provider: "openai", field: "apiKey" },
      { name: "ANTHROPIC_API_KEY", purpose: "api_key", secret: true, provider: "anthropic", field: "apiKey" },
      { name: "GOOGLE_API_KEY", purpose: "api_key", secret: true, provider: "google", field: "apiKey" },
      { name: "GEMINI_API_KEY", purpose: "api_key", secret: true, provider: "google", field: "apiKey" },
      { name: "NOUS_API_KEY", purpose: "api_key", secret: true, provider: "nous", field: "apiKey" },
      { name: "XAI_API_KEY", purpose: "api_key", secret: true, provider: "xai", field: "apiKey" },
      { name: "DEEPSEEK_API_KEY", purpose: "api_key", secret: true, provider: "deepseek", field: "apiKey" },
      { name: "KIMI_API_KEY", purpose: "api_key", secret: true, provider: "kimi-coding", field: "apiKey" },
    ],
    stores: [
      { kind: "file", directoryEnv: "HERMES_HOME", defaultDirectory: ".hermes", path: ".env" },
      { kind: "file", directoryEnv: "HERMES_HOME", defaultDirectory: ".hermes", path: "auth.json" },
      { kind: "file", directoryEnv: "HERMES_HOME", defaultDirectory: ".hermes", path: "config.yaml" },
    ],
  },
  installation: hermesInstallation,
  refusedSessionOptions: hermesRefusedSessionOptions,
  // The gateway re-freezes editor MCP tools per session; a changed list
  // applies to the next turn, not the running one.
  mcpToolsListChanged: "none",
  session: onFirstCall(async () => {
    const { hermesSession } = await import("./session.js");
    return hermesSession;
  }),
  listModels: onFirstCall(async () => {
    const { hermesListModels } = await import("./list-models.js");
    return hermesListModels;
  }),
}, { execution: "process" });
