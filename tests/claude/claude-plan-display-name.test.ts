import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeAuthStatus } from "../../packages/oar/src/runtimes/claude/auth-status.js";
import { claudeAccountUsage } from "../../packages/oar/src/runtimes/claude/account-usage.js";
import { claudePlanDisplayName } from "../../packages/oar/src/runtimes/claude/last-account.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "oar-claude-plan-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function writeClaudeConfig(dir: string, oauthAccount: unknown): Promise<void> {
  await writeFile(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount }));
}

interface FakeClaudeConfig {
  readonly statusJson: Record<string, unknown>;
  readonly usageResponse: Record<string, unknown>;
  readonly initAccount: Record<string, unknown>;
}

async function createFakeClaude(
  name: string,
  config: FakeClaudeConfig,
): Promise<{ readonly kind: "available"; readonly via: "executable"; readonly command: string }> {
  const subdir = path.join(directory, name);
  await mkdir(subdir, { recursive: true });
  const script = path.join(subdir, "fake-claude.mjs");
  await writeFile(script, [
    'import { createInterface } from "node:readline";',
    "const args = process.argv.slice(2);",
    String.raw`if (args[0] === "--help") { process.stdout.write("Usage: claude --safe-mode\n"); process.exit(0); }`,
    `if (args[0] === "auth" && args[1] === "status") { process.stdout.write(${JSON.stringify(JSON.stringify(config.statusJson))}); process.exit(0); }`,
    'const rl = createInterface({ input: process.stdin });',
    'rl.on("line", (line) => {',
    "  const msg = JSON.parse(line);",
    '  if (msg.type !== "control_request") { return; }',
    '  if (msg.request?.subtype === "initialize") {',
    `    process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { account: ${JSON.stringify(config.initAccount)} } } }) + "\\n");`,
    '  } else if (msg.request?.subtype === "get_usage") {',
    `    process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: ${JSON.stringify(config.usageResponse)} } }) + "\\n");`,
    "  }",
    "});",
  ].join("\n"));
  return { kind: "available", via: "executable", command: fakeAgentBinary(subdir, [script]) };
}

test.each([
  ["Ultra", "Ultra"],
  ["Max 20x", "Max 20x"],
  ["Pro+", "Pro+"],
  ["A", "A"],
  ["A".repeat(40), "A".repeat(40)],
  ["A".repeat(41), undefined],
  [" Ultra", undefined],
  ["Ultra ", undefined],
  ["", undefined],
  ["-Ultra", undefined],
  ["Ultra-", undefined],
  ["Ultra\nInjected", undefined],
  ["Ultra!", undefined],
] as const)("claudePlanDisplayName enforces Claude Code's native planDisplayName regex: %j", async (candidate, expected) => {
  await writeClaudeConfig(directory, { emailAddress: "alice@example.test", organizationUuid: "org-1", planDisplayName: candidate });
  expect(await claudePlanDisplayName({ CLAUDE_CONFIG_DIR: directory }, { email: "alice@example.test", orgId: "org-1" })).toBe(expected);
});

test("claudePlanDisplayName matches email or orgId and rejects stale or conflicting profiles", async () => {
  await writeClaudeConfig(directory, {
    emailAddress: "Alice@Example.test",
    organizationUuid: "org-ultra",
    organizationName: "Ultra Org",
    planDisplayName: "Ultra",
  });
  const env = { CLAUDE_CONFIG_DIR: directory };
  expect(await claudePlanDisplayName(env, { email: "alice@example.test" })).toBe("Ultra");
  expect(await claudePlanDisplayName(env, { orgId: "org-ultra" })).toBe("Ultra");
  expect(await claudePlanDisplayName(env, { email: "alice@example.test", orgId: "org-max" })).toBeUndefined();
  expect(await claudePlanDisplayName(env, { email: "bob@example.test", orgId: "org-ultra" })).toBeUndefined();
  expect(await claudePlanDisplayName(env, { email: "alice@example.test", orgName: "Other Org" })).toBeUndefined();
  expect(await claudePlanDisplayName(env, {})).toBeUndefined();
});

test("claudeAuthStatus and claudeAccountUsage prefer matched planDisplayName over subscriptionType max", async () => {
  const configDir = path.join(directory, "config");
  const homeDir = path.join(directory, "home");
  await Promise.all([mkdir(configDir, { recursive: true }), mkdir(homeDir, { recursive: true })]);
  await writeClaudeConfig(homeDir, { emailAddress: "alice@example.test", organizationUuid: "org-ultra", accountUuid: "acct-home", planDisplayName: "HomePlan" });
  await writeClaudeConfig(configDir, { emailAddress: "alice@example.test", organizationUuid: "org-ultra", organizationName: "Ultra Org", accountUuid: "acct-ultra-1", planDisplayName: "Ultra" });
  const installation = await createFakeClaude("ultra", {
    statusJson: { loggedIn: true, authMethod: "claude.ai", email: "alice@example.test", orgId: "org-ultra", orgName: "Ultra Org", subscriptionType: "max" },
    usageResponse: { rate_limits_available: true, subscription_type: "max", rate_limits: { five_hour: { utilization: 10 } } },
    initAccount: { email: "alice@example.test", organization: "Ultra Org" },
  });
  const env = { HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: configDir };
  expect(await claudeAuthStatus(installation, { env })).toEqual({
    kind: "logged_in",
    source: "claude auth status --json",
    account: { credential: "account", metering: "plan", email: "alice@example.test", accountId: "acct-ultra-1", plan: "Ultra", method: "claude.ai" },
  });
  const usage = await claudeAccountUsage(installation, { env });
  expect(usage.kind === "available" ? usage.plan : undefined).toBe("Ultra");
});

test("claudeAuthStatus and claudeAccountUsage fall back to native subscription code on account mismatch", async () => {
  await writeClaudeConfig(directory, { emailAddress: "other@example.test", organizationUuid: "org-other", accountUuid: "acct-other", planDisplayName: "Ultra" });
  const env = { CLAUDE_CONFIG_DIR: directory };
  const installation = await createFakeClaude("mismatch", {
    statusJson: { loggedIn: true, authMethod: "claude.ai", email: "alice@example.test", orgId: "org-max", subscriptionType: "max" },
    usageResponse: { rate_limits_available: true, subscription_type: "max", rate_limits: { five_hour: { utilization: 10 } } },
    initAccount: { email: "alice@example.test" },
  });
  const status = await claudeAuthStatus(installation, { env });
  expect(status.kind === "logged_in" ? status.account?.plan : undefined).toBe("max");
  expect(status.kind === "logged_in" ? status.account?.accountId : undefined).toBeUndefined();
  const usage = await claudeAccountUsage(installation, { env });
  expect(usage.kind === "available" ? usage.plan : undefined).toBe("max");
});

test("claudeAuthStatus ignores stored planDisplayName and accountUuid for API-key logins", async () => {
  await writeClaudeConfig(directory, { emailAddress: "alice@example.test", organizationUuid: "org-1", accountUuid: "acct-1", planDisplayName: "Ultra" });
  const installation = await createFakeClaude("apikey", {
    statusJson: { loggedIn: true, authMethod: "api_key", email: "alice@example.test", orgId: "org-1" },
    usageResponse: { rate_limits_available: false },
    initAccount: { email: "alice@example.test" },
  });
  const status = await claudeAuthStatus(installation, { env: { CLAUDE_CONFIG_DIR: directory } });
  expect(status.kind === "logged_in" ? status.account?.plan : undefined).toBeUndefined();
  expect(status.kind === "logged_in" ? status.account?.accountId : undefined).toBeUndefined();
});
