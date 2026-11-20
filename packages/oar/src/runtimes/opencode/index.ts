import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { opencodeUpgrade } from "./upgrade.js";
import { opencodeInstallation } from "./installation.js";
import { opencodeInstall, opencodeInstallLines, opencodeInstallPlan } from "./install.js";
import { opencodeListModels } from "./list-models.js";
import { opencodeRefusedSessionOptions, opencodeSessionCapabilities } from "./options.js";
import { opencodeSharedRefusal } from "./sharing-admission.js";

export const opencodeRuntime = defineRuntime({
  id: "opencode",
  sessionCapabilities: opencodeSessionCapabilities,
  brand: runtimeBrands.opencode, verifiedPlatforms: verifiedPlatforms.opencode,
  // OpenCode 1.18.30 / 2.2.7: $XDG_DATA_HOME/opencode/auth.json, $XDG_CONFIG_HOME/opencode/opencode.json, {env:VAR} interpolation.
  credentials: {
    scope: "per_provider",
    management: "native",
    signInPaste: "code",
    interpolation: [{ syntax: "{env:VAR}", target: "env" }],
    env: [
      { name: "OPENCODE_API_KEY", purpose: "api_key", secret: true, provider: "opencode", field: "apiKey" },
      { name: "OPENAI_API_KEY", purpose: "api_key", secret: true, provider: "openai", field: "apiKey" },
      { name: "ANTHROPIC_API_KEY", purpose: "api_key", secret: true, provider: "anthropic", field: "apiKey" },
      { name: "GOOGLE_GENERATIVE_AI_API_KEY", purpose: "api_key", secret: true, provider: "google", field: "apiKey" },
      { name: "GEMINI_API_KEY", purpose: "api_key", secret: true, provider: "google", field: "apiKey" },
      { name: "OPENROUTER_API_KEY", purpose: "api_key", secret: true, provider: "openrouter", field: "apiKey" },
      { name: "DEEPSEEK_API_KEY", purpose: "api_key", secret: true, provider: "deepseek", field: "apiKey" },
      { name: "XAI_API_KEY", purpose: "api_key", secret: true, provider: "xai", field: "apiKey" },
      { name: "GROQ_API_KEY", purpose: "api_key", secret: true, provider: "groq", field: "apiKey" },
      { name: "MISTRAL_API_KEY", purpose: "api_key", secret: true, provider: "mistral", field: "apiKey" },
      { name: "CEREBRAS_API_KEY", purpose: "api_key", secret: true, provider: "cerebras", field: "apiKey" },
      { name: "TOGETHER_API_KEY", purpose: "api_key", secret: true, provider: "togetherai", field: "apiKey" },
      { name: "AZURE_OPENAI_API_KEY", purpose: "api_key", secret: true, provider: "azure", field: "apiKey" },
      { name: "AWS_BEARER_TOKEN_BEDROCK", purpose: "token", secret: true, provider: "amazon-bedrock", field: "authToken" },
      { name: "OPENCODE_CONFIG", purpose: "credential_source", secret: false, field: "credentialSource" },
    ],
    stores: [
      { kind: "file", directoryEnv: "XDG_DATA_HOME", defaultDirectory: ".local/share", path: "opencode/auth.json" },
      { kind: "file", directoryEnv: "XDG_CONFIG_HOME", defaultDirectory: ".config", path: "opencode/opencode.json" },
      { kind: "dir", directoryEnv: "OPENCODE_CONFIG_DIR" },
      { kind: "file", relativeTo: "cwd", path: "opencode.json" },
    ],
  },
  refusedSessionOptions: opencodeRefusedSessionOptions,
  mcpToolsListChanged: "full",
  installation: opencodeInstallation,
  upgrade: opencodeUpgrade,
  installPlan: opencodeInstallPlan,
  install: opencodeInstall,
  installLines: opencodeInstallLines,
  session: onFirstCall(async () => {
    const { opencodeSession } = await import("./session.js");
    return opencodeSession;
  }),
  listModels: opencodeListModels,
  skills: onFirstCall(async () => {
    const { opencodeSkills } = await import("./skills.js");
    return opencodeSkills;
  }),
}, { execution: "process", shared: {
  refusal: opencodeSharedRefusal,
  session: () => onFirstCall(async () => {
    const { createOpenCodeSharedSession } = await import("./shared-session.js");
    return createOpenCodeSharedSession();
  }),
} });

export { createOpencodeProviderAuth, OpencodeProviderAuthError } from "./provider-auth.js";
export type { OpencodeProviderAuth, OpencodeProviderAuthErrorKind, OpencodeProviderAuthOptions } from "./provider-auth.js";
