import assert from "node:assert/strict";
import { test } from "vitest";
import { claudeInstallMethod } from "../packages/oar/src/runtimes/claude/update.js";
import { projectCodexUpdateStatus } from "../packages/oar/src/runtimes/codex/update.js";
import { projectGrokUpdateCheck } from "../packages/oar/src/runtimes/grok/update.js";
import { releaseVersion, updaterEnv, versionAtLeast } from "../packages/oar/src/shared/update.js";

// The native answers each runtime's check reads, as observed on 2026-10-01
// (codex 0.158.0 doctor, grok 1.0.46).

test("release versions are read out of --version lines and release pointers", () => {
  assert.equal(releaseVersion("2.1.284 (Claude Code)"), "2.1.284");
  assert.equal(releaseVersion("codex-cli 0.158.0"), "0.158.0");
  assert.equal(releaseVersion("grok 1.0.46 (2765805b9442) [stable]"), "1.0.46");
  assert.equal(releaseVersion("0.161.0-alpha.9"), "0.161.0-alpha.9");
  assert.equal(releaseVersion("opencode v2.0.26"), "2.0.26");
  assert.equal(releaseVersion("no version here"), undefined);
  assert.equal(versionAtLeast("0.43.0", "0.43.0"), true);
  assert.equal(versionAtLeast("2.1.1", "0.43.0"), true);
  assert.equal(versionAtLeast("0.38.0", "0.43.0"), false);
});

test("the updater environment drops package-script markers and keeps npm configuration", () => {
  const env = updaterEnv({ PATH: "/bin", npm_config_user_agent: "pnpm/11", npm_lifecycle_event: "check", npm_config_prefix: "/opt/npm" });
  assert.deepEqual(env, { PATH: "/bin", npm_config_prefix: "/opt/npm" });
});

function doctor(status: string, latest?: string): unknown {
  return { checks: { "updates.status": { details: { ...(latest === undefined ? {} : { "latest version": latest }), "latest version status": status } } } };
}


test("codex reads the updates.status row of doctor --json", () => {
  assert.deepEqual(projectCodexUpdateStatus("0.158.0", doctor("newer version is available", "0.159.3")), {
    kind: "ok", installed: "0.158.0", latest: "0.159.3", updateAvailable: true, source: "codex doctor --json",
  });
  const current = projectCodexUpdateStatus("0.159.3", doctor("current version is not older", "0.159.3"));
  assert.equal(current.kind === "ok" && current.updateAvailable, false);
  assert.equal(projectCodexUpdateStatus("0.158.0", doctor("unknown")).kind, "unavailable");
  const copied = { checks: { "updates.status": { details: { "latest version": "0.159.3", "update action": "manual or unknown" } } } };
  const unmanaged = projectCodexUpdateStatus("0.158.0", copied);
  assert.equal(unmanaged.kind === "unavailable" ? unmanaged.reason : unmanaged.kind, "unmanaged_installation");
});

test("grok's check JSON decides, and a lookup error is never a current installation", () => {
  const ok = projectGrokUpdateCheck("1.0.44", {
    currentVersion: "1.0.44", latestVersion: "1.0.46", updateAvailable: true, installer: "internal", channel: "stable", error: null,
  });
  assert.deepEqual(ok, { kind: "ok", installed: "1.0.44", latest: "1.0.46", updateAvailable: true, channel: "stable", source: "grok update --check --json" });
  const failed = projectGrokUpdateCheck("1.0.46", { latestVersion: null, updateAvailable: false, error: "GCS channel pointer fetch failed" });
  assert.equal(failed.kind === "unavailable" ? failed.reason : failed.kind, "lookup_failed");
  assert.equal(projectGrokUpdateCheck("1.0.46", undefined).kind, "unavailable");
});

test("claude's install method comes from the executable's real path", () => {
  assert.equal(claudeInstallMethod("/home/u/.local/share/claude/versions/2.1.286"), "native");
  assert.equal(claudeInstallMethod("/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"), "npm");
  assert.equal(claudeInstallMethod("/opt/homebrew/Caskroom/claude-code/2.1.285/claude"), "package_manager");
  // A shim whose path is not a layout defers to claude's recorded method.
  assert.equal(claudeInstallMethod("C:/Users/u/AppData/Roaming/npm/claude.cmd", "global"), "npm");
  assert.equal(claudeInstallMethod("/home/u/.local/share/claude/versions/2.1.286", "global"), "native");
});
