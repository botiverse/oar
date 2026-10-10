import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import { claudeEnv } from "../../packages/oar/src/runtimes/claude/environment.js";
import { upgradeExecutable } from "../../packages/oar/src/shared/update.js";
import { fakeRuntime } from "../fixtures/update-fixtures.js";

// `claude update` runs without the parent Claude Code session's markers (#309),
// on top of the shared updater's script-context filter.

const dir = mkdtempSync(path.join(tmpdir(), "oar-claude-update-env-"));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });

test("the updater gets neither the parent's messaging token nor a package manager's script context", async () => {
  const fake = fakeRuntime(dir, "env", { version: "1.0.0", target: "1.1.0", mode: "upgrade" });
  vi.stubEnv("CLAUDE_CODE_MESSAGING_TOKEN", "parent-session-token");
  vi.stubEnv("npm_config_user_agent", "pnpm/11.22.0");
  await upgradeExecutable(
    { kind: "available", via: "executable", command: fake.command, version: "fake 1.0.0" },
    { check: async () => { await Promise.resolve(); return { kind: "ok", installed: "1.0.0", latest: "1.1.0", updateAvailable: true, source: "fixture" }; }, args: ["update"], env: claudeEnv },
  );
  assert.equal(fake.read().sawMessagingToken, false);
  assert.equal(fake.read().sawUserAgent, false);
});
