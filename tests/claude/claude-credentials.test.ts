import { expect, test } from "vitest";
import { claudeRuntime } from "../../packages/oar/src/runtimes/claude/index.js";

test("Claude declares provider and credential inputs as names, including potentially secret custom headers", () => {
  const variables = claudeRuntime.credentials.env ?? [];
  const byName = new Map(variables.map(v => [v.name, v]));
  expect(byName.size).toBe(variables.length);
  for (const [name, purpose, secret] of [
    ["ANTHROPIC_API_KEY", "api_key", true], ["AWS_BEARER_TOKEN_BEDROCK", "token", true],
    ["ANTHROPIC_CUSTOM_HEADERS", "headers", true], ["ANTHROPIC_VERTEX_BASE_URL", "base_url", false],
    ["CLAUDE_CODE_USE_GATEWAY", "provider_selector", false], ["CLAUDE_CODE_SKIP_MANTLE_AUTH", "provider_selector", false],
    ["CLOUD_ML_REGION", "region", false], ["ANTHROPIC_FEDERATION_RULE_ID", "account_scope", false],
    ["ANTHROPIC_CUSTOM_MODEL_OPTION", "model_route", false], ["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "credential_source", false],
  ] as const) {
    expect(byName.get(name)).toEqual({ name, purpose, secret });
  }
  for (const absent of ["ANTHROPIC_BEDROCK_MANTLE_API_KEY", "ANTHROPIC_BEDROCK_SERVICE_TIER", "CLAUDE_CODE_USE_CCR_V2"]) {
    expect(byName.has(absent), absent).toBe(false);
  }
  expect(claudeRuntime.credentials.stores?.some(store => store.kind === "keychain")).toBe(process.platform === "darwin");
  expect(claudeRuntime.credentials.stores).toEqual(expect.arrayContaining([
    { kind: "file", directoryEnv: "CLAUDE_CONFIG_DIR", defaultDirectory: ".claude", path: ".credentials.json" },
  ]));
});
