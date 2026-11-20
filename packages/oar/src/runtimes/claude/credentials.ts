import type { CredentialField, CredentialVariable, RuntimeCredentials } from "../../contracts/credentials.js";

const DEFAULT_FIELD: Readonly<Record<CredentialVariable["purpose"], CredentialField>> = {
  api_key: "apiKey",
  token: "authToken",
  base_url: "baseUrl",
  headers: "headers",
  region: "region",
  account_scope: "accountScope",
  model_route: "model",
  provider_selector: "provider",
  credential_source: "credentialSource",
};

function variables(purpose: CredentialVariable["purpose"], provider: string | undefined, ...names: string[]): CredentialVariable[] {
  const secret = purpose === "api_key" || purpose === "token" || purpose === "headers";
  const field = DEFAULT_FIELD[purpose];
  return names.map(name => (provider === undefined ? { name, purpose, secret, field } : { name, purpose, secret, field, provider }));
}

/** Claude Code 2.1.328. Each group follows a native client or credential reader (docs/runtimes/claude.md#credentials). */
export const claudeCredentials: RuntimeCredentials = {
  scope: "single_account",
  management: "native",
  signInPaste: "code",
  usageDirectoryEnv: "CLAUDE_CONFIG_DIR",
  env: [
    // Direct API, bearer auth, host-managed gateway and OAuth refresh.
    ...variables("api_key", "anthropic", "ANTHROPIC_API_KEY"),
    ...variables("token", "anthropic", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"),
    ...variables("headers", "anthropic", "ANTHROPIC_CUSTOM_HEADERS"),
    ...variables("base_url", "anthropic", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_CUSTOM_OAUTH_URL"),
    ...variables("provider_selector", undefined, "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"),
    ...variables("credential_source", "anthropic", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
      "CLAUDE_BG_AUTH_SNAPSHOT_PATH", "ANTHROPIC_UNIX_SOCKET"),
    ...variables("account_scope", "anthropic", "CLAUDE_CODE_OAUTH_CLIENT_ID", "CLAUDE_CODE_OAUTH_SCOPES"),
    // Anthropic identity profiles and federated token exchange.
    ...variables("credential_source", "anthropic", "ANTHROPIC_PROFILE",
      "ANTHROPIC_IDENTITY_TOKEN_FILE", "CLAUDE_CODE_FEDERATION_CACHE_DIR"),
    ...variables("token", "anthropic", "ANTHROPIC_IDENTITY_TOKEN"),
    ...variables("account_scope", "anthropic", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_WORKSPACE_ID"),
    // Bedrock, Mantle and Claude Platform on AWS select different clients using the same AWS credential chain.
    ...variables("provider_selector", "amazon-bedrock", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_SKIP_MANTLE_AUTH", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH"),
    ...variables("base_url", "amazon-bedrock", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "ANTHROPIC_AWS_BASE_URL"),
    ...variables("token", "amazon-bedrock", "AWS_BEARER_TOKEN_BEDROCK"),
    ...variables("api_key", "amazon-bedrock", "ANTHROPIC_AWS_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"),
    ...variables("token", "amazon-bedrock", "AWS_SESSION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN"),
    ...variables("account_scope", "amazon-bedrock", "ANTHROPIC_AWS_WORKSPACE_ID", "AWS_ROLE_ARN"),
    ...variables("region", "amazon-bedrock", "AWS_REGION", "AWS_DEFAULT_REGION", "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION", "ANTHROPIC_BEDROCK_REGION_PREFIX"),
    ...variables("credential_source", "amazon-bedrock", "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_EC2_METADATA_SERVICE_ENDPOINT", "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE"),
    // Vertex AI and Claude Platform on Google Cloud use Google application default credentials.
    ...variables("provider_selector", "google-vertex", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_SKIP_VERTEX_AUTH",
      "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH"),
    ...variables("base_url", "google-vertex", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL"),
    ...variables("account_scope", "google-vertex", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_GOOGLE_CLOUD_PROJECT", "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
      "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_QUOTA_PROJECT"),
    ...variables("region", "google-vertex", "CLOUD_ML_REGION", "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
      "VERTEX_REGION_CLAUDE_3_5_SONNET", "VERTEX_REGION_CLAUDE_3_7_SONNET", "VERTEX_REGION_CLAUDE_4_5_SONNET",
      "VERTEX_REGION_CLAUDE_4_6_SONNET", "VERTEX_REGION_CLAUDE_5_5_SONNET", "VERTEX_REGION_CLAUDE_3_5_HAIKU",
      "VERTEX_REGION_CLAUDE_FABLE_5_1", "VERTEX_REGION_CLAUDE_FABLE_5_2", "VERTEX_REGION_CLAUDE_HAIKU_4_5",
      "VERTEX_REGION_CLAUDE_HAIKU_5_5", "VERTEX_REGION_CLAUDE_4_1_OPUS", "VERTEX_REGION_CLAUDE_4_5_OPUS",
      "VERTEX_REGION_CLAUDE_4_6_OPUS", "VERTEX_REGION_CLAUDE_4_7_OPUS", "VERTEX_REGION_CLAUDE_4_8_OPUS",
      "VERTEX_REGION_CLAUDE_5_5_OPUS", "VERTEX_REGION_CLAUDE_4_0_SONNET", "VERTEX_REGION_CLAUDE_5_SONNET",
      "VERTEX_REGION_CLAUDE_FABLE_5", "VERTEX_REGION_CLAUDE_4_0_OPUS", "VERTEX_REGION_CLAUDE_5_OPUS"),
    ...variables("credential_source", "google-vertex", "GOOGLE_APPLICATION_CREDENTIALS", "google_application_credentials", "GCE_METADATA_HOST", "GCE_METADATA_IP"),
    // Foundry's explicit credentials and Entra environment / workload identity.
    ...variables("provider_selector", "azure-foundry", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH"),
    ...variables("base_url", "azure-foundry", "ANTHROPIC_FOUNDRY_BASE_URL", "AZURE_AUTHORITY_HOST"),
    ...variables("token", "azure-foundry", "ANTHROPIC_FOUNDRY_AUTH_TOKEN"),
    ...variables("api_key", "azure-foundry", "ANTHROPIC_FOUNDRY_API_KEY", "AZURE_CLIENT_SECRET"),
    { name: "AZURE_CLIENT_CERTIFICATE_PASSWORD", purpose: "credential_source", secret: true, provider: "azure-foundry", field: "credentialSource" },
    ...variables("account_scope", "azure-foundry", "ANTHROPIC_FOUNDRY_RESOURCE", "AZURE_TENANT_ID", "AZURE_CLIENT_ID"),
    ...variables("credential_source", "azure-foundry", "AZURE_FEDERATED_TOKEN_FILE", "AZURE_CLIENT_CERTIFICATE_PATH", "AZURE_TOKEN_CREDENTIALS"),
    // Model aliases may point at a cloud deployment. Display names and descriptions do not select one.
    ...variables("model_route", undefined, "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_CUSTOM_MODEL_OPTION", "ANTHROPIC_DEFAULT_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL"),
  ],
  stores: [
    // macOS Keychain service is "Claude Code-credentials" (suffixed "-<sha256(CLAUDE_CONFIG_DIR)[0..8]>" when CLAUDE_CONFIG_DIR is set).
    ...(process.platform === "darwin" ? [{ kind: "keychain" as const, directoryEnv: "CLAUDE_CONFIG_DIR", defaultDirectory: ".claude", service: "Claude Code-credentials" }] : []),
    { kind: "file", directoryEnv: "CLAUDE_CONFIG_DIR", defaultDirectory: ".claude", path: ".credentials.json" },
    { kind: "file", directoryEnv: "CLAUDE_CONFIG_DIR", defaultDirectory: ".", path: ".claude.json" },
    { kind: "file", directoryEnv: "CLAUDE_CONFIG_DIR", defaultDirectory: ".claude", path: "settings.json" },
    { kind: "file", relativeTo: "cwd", path: ".claude/settings.local.json" },
    { kind: "file", relativeTo: "cwd", path: ".claude/settings.json" },
    // defaultDirectory is home-relative. With XDG_CONFIG_HOME set, the native fallback is XDG_CONFIG_HOME/anthropic.
    { kind: "dir", directoryEnv: "ANTHROPIC_CONFIG_DIR", defaultDirectory: ".config/anthropic" },
    { kind: "file", defaultDirectory: ".aws", path: "credentials" },
    { kind: "file", defaultDirectory: ".aws", path: "config" },
    process.platform === "win32"
      ? { kind: "file", directoryEnv: "APPDATA", defaultDirectory: "AppData/Roaming", path: "gcloud/application_default_credentials.json" }
      : { kind: "file", defaultDirectory: ".config/gcloud", path: "application_default_credentials.json" },
  ],
};
