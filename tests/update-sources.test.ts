import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { antigravityUpdateCheck } from "../packages/oar/src/runtimes/antigravity/update.js";
import { claudeCheckUpdate, claudeUpdateCheck, claudeUpgrade, claudeUpgrader } from "../packages/oar/src/runtimes/claude/update.js";
import { devinReleaseSource, devinUpdateCheck } from "../packages/oar/src/runtimes/devin/update.js";
import { kimiUpdateCheck } from "../packages/oar/src/runtimes/kimi/update.js";
import { startReleaseServer, type ReleaseServer } from "./fixtures/update-fixtures.js";

let server: ReleaseServer = { base: "", routes: new Map(), close: () => undefined };
let dir = "";
let base = "";
let { routes } = server;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "oar-update-sources-"));
  server = await startReleaseServer();
  ({ base, routes } = server);
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

type Installation = Parameters<ReturnType<typeof kimiUpdateCheck>>[0];

function executable(command: string, version: string): Installation {
  return { kind: "available", via: "executable", command, version };
}

test("a bundled installation has no update check", async () => {
  const check = await kimiUpdateCheck({ mainland: `${base}/x`, global: `${base}/x`, home: () => dir })({ kind: "available", via: "bundled" });
  assert.equal(check.kind === "unavailable" ? check.reason : check.kind, "unsupported_installation");
});

function claudeSources(configDir: string, owner: string | null = null) {
  return {
    releases: `${base}/claude`,
    npm: `${base}/npm`,
    configDir: () => configDir,
    globalConfig: () => path.join(configDir, ".claude.json"),
    systemPackageManager: async () => { await Promise.resolve(); return owner; },
  };
}

test("claude checks the channel its settings choose, at the source its updater reads", async () => {
  const configDir = claudeConfig("claude-config", { autoUpdatesChannel: "stable" });
  routes.set("/claude/stable", [200, "2.1.285\n"]);
  const check = claudeUpdateCheck(claudeSources(configDir));
  const nativePath = path.join(dir, "claude", "versions", "2.1.286");
  const native = await check(executable(nativePath, "2.1.286 (Claude Code)"));
  assert.deepEqual(native, {
    kind: "ok", installed: "2.1.286", latest: "2.1.285", updateAvailable: true, channel: "stable", source: `${base}/claude/stable`,
  });
  writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ env: { DISABLE_UPDATES: "1" } }));
  const disabled = await check(executable(nativePath, "2.1.286 (Claude Code)"));
  assert.equal(disabled.kind === "unavailable" ? disabled.reason : disabled.kind, "updates_disabled");
});

test("claude reports system-package-owned copies unavailable/unsupported even with stale global config", async () => {
  const configDir = claudeConfig("claude-dpkg-config", {});
  writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ installMethod: "global" }));
  const sources = claudeSources(configDir, "dpkg");
  const owned = executable("/usr/bin/claude", "2.1.292 (Claude Code)");
  assert.deepEqual(await claudeUpdateCheck(sources)(owned), { kind: "unavailable", reason: "package_manager", detail: "this copy updates through dpkg" });
  assert.deepEqual(await claudeUpgrader(sources)(owned), { kind: "unsupported", reason: "unsupported_installation", detail: "this copy updates through dpkg" });
});

test("claude reports unrecognized layouts unmanaged/unsupported without running claude update", async () => {
  const sources = claudeSources(claudeConfig("claude-unrecognized-config", {}));
  const unrecognized = executable("/usr/bin/claude", "2.1.292 (Claude Code)");
  assert.deepEqual(await claudeUpdateCheck(sources)(unrecognized), { kind: "unavailable", reason: "unmanaged_installation", detail: "Claude installation layout is not recognized" });
  assert.deepEqual(await claudeUpgrader(sources)(unrecognized), { kind: "unsupported", reason: "unsupported_installation", detail: "Claude installation layout is not recognized" });
});

test("a Claude Desktop cache copy leaves checks and upgrades to Desktop", async () => {
  const copy = executable(path.join(dir, "Library/Application Support/Claude/claude-code/2.1.321/cache-a/claude.app/Contents/MacOS/claude"), "2.1.321");
  const detail = "Claude Desktop installs, verifies and updates this copy";
  assert.deepEqual(await claudeCheckUpdate(copy), { kind: "unavailable", reason: "package_manager", detail });
  assert.deepEqual(await claudeUpgrade(copy), { kind: "unsupported", reason: "unsupported_installation", detail });
});

function kimiHome(region: string): string {
  const home = path.join(dir, "kimi-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "region"), `${region}\n`);
  return home;
}

function claudeConfig(name: string, settings: Record<string, unknown>): string {
  const configDir = path.join(dir, name);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings));
  return configDir;
}

test("a claude copy claude records as npm follows the npm dist tag, held by minimumVersion", async () => {
  const configDir = claudeConfig("claude-npm-config", { autoUpdatesChannel: "stable", minimumVersion: "2.1.286" });
  writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ installMethod: "global" }));
  routes.set("/npm/stable", [200, JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.285" })]);
  const check = claudeUpdateCheck(claudeSources(configDir));
  // A pnpm shim: the path says nothing, the recorded method says npm.
  const result = await check(executable(path.join(dir, "pnpm-bin", "claude"), "2.1.286 (Claude Code)"));
  assert.deepEqual(result, {
    kind: "ok", installed: "2.1.286", latest: "2.1.285", updateAvailable: false, channel: "stable", source: `${base}/npm/stable`,
  });
});

test("kimi follows its recorded region, and a failed lookup is reported as such", async () => {
  const home = kimiHome("global");
  routes.set("/kimi-global", [200, "2.1.1\n"]);
  routes.set("/kimi-cn", [503, "busy"]);
  const check = kimiUpdateCheck({ mainland: `${base}/kimi-cn`, global: `${base}/kimi-global`, home: () => home });
  const global = await check(executable(path.join(dir, "kimi"), "2.1.0"));
  assert.equal(global.kind === "ok" ? global.latest : global.kind, "2.1.1");
  kimiHome("mainland-cn");
  const mainland = await check(executable(path.join(dir, "kimi"), "2.1.0"));
  assert.deepEqual(mainland, { kind: "unavailable", reason: "lookup_failed", detail: "HTTP 503", source: `${base}/kimi-cn` });
});

test("kimi counts only a newer release as an update, as its upgrade does", async () => {
  const home = kimiHome("global");
  routes.set("/kimi-behind", [200, "2.0.9\n"]);
  const check = kimiUpdateCheck({ mainland: `${base}/kimi-behind`, global: `${base}/kimi-behind`, home: () => home });
  const ahead = await check(executable(path.join(dir, "kimi"), "2.1.0"));
  assert.equal(ahead.kind === "ok" && ahead.updateAvailable, false);
});

test("antigravity counts only a newer CLI manifest version as an update", async () => {
  routes.set("/agy-manifest.json", [200, JSON.stringify({ version: "1.5.0" })]);
  const check = antigravityUpdateCheck(`${base}/agy-manifest.json`);
  const ahead = await check(executable(path.join(dir, "agy"), "1.6.0"));
  assert.equal(ahead.kind === "ok" && ahead.updateAvailable, false);
  const behind = await check(executable(path.join(dir, "agy"), "1.4.9"));
  assert.equal(behind.kind === "ok" && behind.updateAvailable, true);
});

test("devinReleaseSource maps standalone distribution markers to release manifests and rejects non-standalone markers", () => {
  assert.equal(devinReleaseSource("curl-bash"), "https://static.devin.ai/cli/current/manifest.json");
  assert.equal(devinReleaseSource("irm-iex"), "https://static.devin.ai/cli/current/manifest.json");
  assert.equal(devinReleaseSource("curl-bash-enterprise"), "https://static.devinenterprise.com/cli/current/manifest-enterprise.json");
  assert.equal(devinReleaseSource("irm-iex-enterprise"), "https://static.devinenterprise.com/cli/current/manifest-enterprise.json");
  assert.equal(devinReleaseSource("curl-bash-windsurfcom"), "https://static.devin.ai/cli/current/manifest-windsurfcom.json");
  assert.equal(devinReleaseSource("irm-iex-windsurfcom"), "https://static.devin.ai/cli/current/manifest-windsurfcom.json");
  assert.equal(devinReleaseSource("homebrew"), undefined);
  assert.equal(devinReleaseSource(undefined), undefined);
});

test("devinUpdateCheck verifies manifest version and refuses missing distribution markers", async () => {
  const unsupported = await devinUpdateCheck({ readDistribution: () => undefined })(executable(path.join(dir, "devin"), "3000.12.57"));
  assert.equal(unsupported.kind === "unavailable" ? unsupported.reason : unsupported.kind, "unsupported_installation");

  routes.set("/devin-manifest.json", [200, JSON.stringify({ version: "3000.12.58" })]);
  const check = devinUpdateCheck({ manifestUrl: `${base}/devin-manifest.json`, readDistribution: () => "curl-bash" });
  const behind = await check(executable(path.join(dir, "devin"), "3000.12.57"));
  assert.deepEqual(behind, {
    kind: "ok",
    installed: "3000.12.57",
    latest: "3000.12.58",
    updateAvailable: true,
    source: `${base}/devin-manifest.json`,
  });
  const current = await check(executable(path.join(dir, "devin"), "3000.12.58"));
  assert.equal(current.kind === "ok" && current.updateAvailable, false);
});

