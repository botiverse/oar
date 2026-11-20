import type { CredentialVariable, RuntimeCredentials } from "../../contracts/credentials.js";

const apiKey = (name: string, provider: string): CredentialVariable => ({
  name, purpose: "api_key", secret: true, provider, field: "apiKey",
});

/**
 * Qwen Code 0.26.2 credential shape, grounded in `qwen/auth-status.ts` and
 * `qwen/auth-files.ts`. No OAuth login member is exposed (`signInPaste` omitted).
 */
export const qwenCredentials: RuntimeCredentials = {
  scope: "per_provider",
  management: "native",
  env: [
    apiKey("OPENAI_API_KEY", "openai"),
    apiKey("ANTHROPIC_API_KEY", "anthropic"),
    apiKey("GEMINI_API_KEY", "gemini"),
    apiKey("GOOGLE_API_KEY", "gemini"),
    apiKey("BAILIAN_CODING_PLAN_API_KEY", "bailian"),
    apiKey("BAILIAN_TOKEN_PLAN_API_KEY", "bailian"),
    apiKey("OPENROUTER_API_KEY", "openrouter"),
    apiKey("REQUESTY_API_KEY", "requesty"),
    apiKey("DASHSCOPE_API_KEY", "dashscope"),
    apiKey("QWENCLOUD_API_KEY", "qwencloud"),
    apiKey("QWENCLOUD_TOKEN_PLAN_API_KEY", "qwencloud"),
    apiKey("MOONSHOT_API_KEY", "moonshot"),
    apiKey("IDEALAB_API_KEY", "idealab"),
    apiKey("MODELSCOPE_API_KEY", "modelscope"),
    apiKey("MINIMAX_API_KEY", "minimax"),
    apiKey("ZAI_API_KEY", "zai"),
    apiKey("DEEPSEEK_API_KEY", "deepseek"),
    apiKey("XAI_API_KEY", "xai"),
    { name: "OPENAI_BASE_URL", purpose: "base_url", secret: false, provider: "openai", field: "baseUrl" },
    { name: "OPENAI_MODEL", purpose: "model_route", secret: false, provider: "openai", field: "model" },
    { name: "GOOGLE_APPLICATION_CREDENTIALS", purpose: "credential_source", secret: false, provider: "vertex-ai", field: "credentialSource" },
    { name: "GOOGLE_CLOUD_PROJECT", purpose: "account_scope", secret: false, provider: "vertex-ai", field: "project" },
    { name: "QWEN_OAUTH", purpose: "provider_selector", secret: false, provider: "qwen-oauth", field: "provider" },
    { name: "QWEN_CODE_SYSTEM_SETTINGS_PATH", purpose: "credential_source", secret: false, field: "credentialSource" },
    { name: "QWEN_CODE_SYSTEM_DEFAULTS_PATH", purpose: "credential_source", secret: false, field: "credentialSource" },
  ],
  stores: [
    { kind: "file", directoryEnv: "QWEN_HOME", defaultDirectory: ".qwen", path: "settings.json" },
    { kind: "file", directoryEnv: "QWEN_HOME", defaultDirectory: ".qwen", path: ".env", overridesEnv: false },
    { kind: "file", defaultDirectory: ".", path: ".env", overridesEnv: false },
    { kind: "file", relativeTo: "cwd", path: ".env", overridesEnv: false },
    { kind: "file", directoryEnv: "QWEN_HOME", defaultDirectory: ".qwen", path: "oauth_creds.json" },
    { kind: "file", defaultDirectory: ".config/gcloud", path: "application_default_credentials.json", overridesEnv: false },
  ],
};
