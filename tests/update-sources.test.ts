import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { antigravityUpdateCheck } from "../packages/oar/src/runtimes/antigravity/update.js";
import { claudeUpdateCheck } from "../packages/oar/src/runtimes/claude/update.js";
import { cursorUpdateCheck } from "../packages/oar/src/runtimes/cursor/update.js";
import { kimiUpdateCheck } from "../packages/oar/src/runtimes/kimi/update.js";
import { startReleaseServer, type ReleaseServer } from "./fixtures/release-server.js";

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

test("claude checks the channel its settings choose, at the source its updater reads", async () => {
  const configDir = path.join(dir, "claude-config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ autoUpdatesChannel: "stable" }));
  routes.set("/claude/stable", [200, "2.1.285\n"]);
  const check = claudeUpdateCheck({ releases: `${base}/claude`, npm: `${base}/npm`, configDir: () => configDir });
  const native = await check(executable(path.join(dir, "claude-native"), "2.1.286 (Claude Code)"));
  assert.deepEqual(native, {
    kind: "ok", installed: "2.1.286", latest: "2.1.285", updateAvailable: true, channel: "stable", source: `${base}/claude/stable`,
  });
  writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ env: { DISABLE_UPDATES: "1" } }));
  const disabled = await check(executable(path.join(dir, "claude-native"), "2.1.286 (Claude Code)"));
  assert.equal(disabled.kind === "unavailable" ? disabled.reason : disabled.kind, "updates_disabled");
});

function kimiHome(region: string): string {
  const home = path.join(dir, "kimi-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "region"), `${region}\n`);
  return home;
}

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

test("antigravity counts only a newer registry version as an update", async () => {
  routes.set("/registry.json", [200, JSON.stringify({ id: "antigravity-acp", version: "1.2.1" })]);
  const check = antigravityUpdateCheck(`${base}/registry.json`);
  const ahead = await check(executable(path.join(dir, "agy"), "1.3.0"));
  assert.equal(ahead.kind === "ok" && ahead.updateAvailable, false);
  const behind = await check(executable(path.join(dir, "agy"), "1.2.0"));
  assert.equal(behind.kind === "ok" && behind.updateAvailable, true);
});

test("cursor builds without a latest report ask the release service for their channel", async () => {
  const fake = path.join(dir, process.platform === "win32" ? "cursor-old.cmd" : "cursor-old");
  const about = JSON.stringify({ cliVersion: "2026.08.11-e8db854" });
  writeFileSync(fake, process.platform === "win32"
    ? `@echo ${about}\r\n`
    : `#!/bin/sh\necho '${about}'\n`);
  chmodSync(fake, 0o755);
  const configPath = path.join(dir, "cli-config.json");
  writeFileSync(configPath, JSON.stringify({ channel: "lab" }));
  routes.set("/cursor-releases", [200, JSON.stringify({ version: "2026.09.28-3cdcc3f" })]);
  const check = await cursorUpdateCheck({ releases: `${base}/cursor-releases`, configPath: () => configPath })(executable(fake, "2026.08.11-e8db854"));
  assert.deepEqual(check, {
    kind: "ok", installed: "2026.08.11-e8db854", latest: "2026.09.28-3cdcc3f", updateAvailable: true, channel: "lab", source: `${base}/cursor-releases`,
  });
});
