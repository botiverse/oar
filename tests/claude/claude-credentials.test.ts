import { expect, test } from "vitest";
import { claudeRuntime } from "../../packages/oar/src/runtimes/claude/index.js";

test("Claude declares provider and credential inputs as names, including potentially secret custom headers", () => {
  const variables = claudeRuntime.credentials.env ?? [];
  const byName = new Map(variables.map(v => [v.name, v]));
  expect(byName.size).toBe(variables.length);
  for (const [name, purpose, secret, field, provider] of [
    ["ANTHROPIC_API_KEY", "api_key", true, "apiKey", "anthropic"],
    ["AWS_BEARER_TOKEN_BEDROCK", "token", true, "authToken", "amazon-bedrock"],
    ["ANTHROPIC_CUSTOM_HEADERS", "headers", true, "headers", "anthropic"],
    ["ANTHROPIC_VERTEX_BASE_URL", "base_url", false, "baseUrl", "google-vertex"],
    ["CLAUDE_CODE_USE_GATEWAY", "provider_selector", false, "provider", undefined],
    ["CLAUDE_CODE_SKIP_MANTLE_AUTH", "provider_selector", false, "provider", "amazon-bedrock"],
    ["CLOUD_ML_REGION", "region", false, "region", "google-vertex"],
    ["ANTHROPIC_FEDERATION_RULE_ID", "account_scope", false, "accountScope", "anthropic"],
    ["ANTHROPIC_CUSTOM_MODEL_OPTION", "model_route", false, "model", undefined],
    ["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "credential_source", false, "credentialSource", "anthropic"],
  ] as const) {
    expect(byName.get(name)).toEqual(
      provider === undefined ? { name, purpose, secret, field } : { name, purpose, secret, field, provider },
    );
  }
  for (const absent of ["ANTHROPIC_BEDROCK_MANTLE_API_KEY", "ANTHROPIC_BEDROCK_SERVICE_TIER", "CLAUDE_CODE_USE_CCR_V2", "XDG_CONFIG_HOME"]) {
    expect(byName.has(absent), absent).toBe(false);
  }
});

test("Claude declares credential shape metadata, stores and macOS keychain service", () => {
  const { credentials } = claudeRuntime;
  expect(credentials).toMatchObject({ scope: "single_account", management: "native", signInPaste: "code", usageDirectoryEnv: "CLAUDE_CONFIG_DIR" });
  expect(credentials.stores?.find(store => store.kind === "keychain")).toEqual(
    process.platform === "darwin"
      ? { kind: "keychain", directoryEnv: "CLAUDE_CONFIG_DIR", defaultDirectory: ".claude", service: "Claude Code-credentials" }
      : undefined,
  );
  expect(credentials.stores).toEqual(expect.arrayContaining([
    { kind: "dir", directoryEnv: "ANTHROPIC_CONFIG_DIR", defaultDirectory: ".config/anthropic" },
    { kind: "file", directoryEnv: "CLAUDE_CONFIG_DIR", defaultDirectory: ".claude", path: ".credentials.json" },
  ]));
});
