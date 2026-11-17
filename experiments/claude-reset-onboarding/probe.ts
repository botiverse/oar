/** Linux, no account: pnpm tsx experiments/claude-reset-onboarding/probe.ts /absolute/claude */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeLimitResetDriver } from "../../packages/oar/src/runtimes/claude/limit-reset/driver.js";
import { openScriptTerminal } from "../../packages/oar/src/shared/executable/script-terminal.js";
import { startBackend } from "./backend.js";

const [command] = process.argv.slice(2);
assert.ok(command !== undefined && path.isAbsolute(command), "pass an absolute Claude executable");
assert.equal(process.platform, "linux");
const root = mkdtempSync(path.join(tmpdir(), "oar-claude-onboarding-"));
const cert = path.join(root, "cert.pem");
const key = path.join(root, "key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.anthropic.com",
  "-addext", "subjectAltName=DNS:api.anthropic.com,DNS:claude.ai,DNS:statsig.anthropic.com,DNS:console.anthropic.com,DNS:platform.claude.com,DNS:claude.com,DNS:api.claude.com",
  "-keyout", key, "-out", cert], { stdio: "ignore" });
const backend = await startBackend(readFileSync(key), readFileSync(cert));
const version = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();

function config(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return { ...value };
}
function changed(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name])).toSorted();
}

async function run(mode: "stored" | "environment"): Promise<void> {
  assert.ok(command !== undefined);
  const home = path.join(root, mode);
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  const project = path.join(home, "empty");
  mkdirSync(project);
  const file = path.join(home, ".claude.json");
  const initial = { oauthAccount: { accountUuid: "00000000-0000-4000-8000-000000000001", emailAddress: "probe@example.invalid", organizationUuid: "00000000-0000-4000-8000-000000000002", displayName: "Synthetic probe" } };
  writeFileSync(file, JSON.stringify(initial));
  if (mode === "stored") {
    writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: "synthetic-not-a-secret", refreshToken: "synthetic-refresh-not-a-secret", expiresAt: Date.now() + 3_600_000,
      scopes: ["user:profile", "user:inference"], subscriptionType: "pro", rateLimitTier: "default_claude_pro",
    } }));
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", TERM: "xterm-256color",
    HTTPS_PROXY: backend.url, HTTP_PROXY: backend.url, ALL_PROXY: backend.url, NODE_EXTRA_CA_CERTS: cert,
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(mode === "environment" ? { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-not-a-secret" } : {}),
  };
  const writes: string[] = [];
  const states: Record<string, unknown>[] = [];
  const screens: string[] = [];
  const driver = createClaudeLimitResetDriver({
    workDir: async () => {
      await access(project);
      return { path: project, remove: async (): Promise<void> => { await rm(project, { recursive: true, force: true }); } };
    },
    // Omitted fiveHourLimit returns unknown: stop before any reset command.
    onScreen: (step) => { screens.push(step); },
    openTerminal: (input) => {
      const terminal = openScriptTerminal(input);
      assert.ok(terminal);
      return { ...terminal, write(data): void { writes.push(data); states.push(config(file)); terminal.write(data); } };
    },
  });
  const started = Date.now();
  const report = await driver.read({ command, env, atFiveHourLimit: false });
  const elapsedMs = Date.now() - started;
  if (mode === "stored") {
    assert.deepEqual(writes, ["\r", "\r", "\u001B[B", "\r"]);
    assert.deepEqual(report.result, { kind: "not_attempted", reason: "usage_unread", onboardingCompleted: true });
    assert.ok(states[0] && states[1] && states[2]);
    assert.deepEqual(changed(states[0], states[1]), [], "default theme writes no field");
    assert.deepEqual(changed(states[1], states[2]), ["hasCompletedOnboarding", "lastOnboardingVersion"]);
    console.log(JSON.stringify({ mode, version, elapsedMs, report, screens, keys: ["Enter", "Enter", "Down", "Enter"],
      initializationFields: changed(initial, states[0]), themeFields: changed(states[0], states[1]), onboardingFields: changed(states[1], states[2]),
      completed: states[2].hasCompletedOnboarding, onboardingVersion: states[2].lastOnboardingVersion }));
  } else {
    assert.deepEqual(writes, ["\r"], "no key on the login-choice page");
    assert.equal(report.result.kind, "not_attempted");
    assert.ok(report.result.reason === "startup_failed" && report.result.startup?.screen === "onboarding");
    assert.equal(report.result.onboardingCompleted, undefined);
    assert.ok(elapsedMs < 20_000, "unknown page must not consume the 30 s startup cutoff");
    console.log(JSON.stringify({ mode, version, elapsedMs, report, screens, keys: ["Enter"] }));
  }
}
try {
  await run("stored");
  await run("environment");
  assert.ok(!backend.routes.some((route) => route.includes("reset_rate_limits")));
  console.log(JSON.stringify({ routes: backend.routes }));
} finally {
  await backend.close();
  rmSync(root, { recursive: true, force: true });
}
