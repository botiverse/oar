import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeInstallation } from "../src/runtimes/claude/installation.js";
import { createCodexInstallation } from "../src/runtimes/codex/installation.js";
import type { ExecutableRunner } from "../src/shared/executable/index.js";

const success: ExecutableRunner = async (_executable, args) => ({
  ok: true,
  stdout: args[0] === "--version" ? "runtime 1.2.3\n" : "",
  stderr: "",
  exitCode: 0,
});

test("codex installation requires the app-server surface", async () => {
  const unavailable = await createCodexInstallation({
    platform: "linux",
    resolve: () => "/bin/codex",
    exists: () => true,
    now: () => 0,
    run: async () => ({ ok: false, stdout: "", stderr: "", exitCode: 1 }),
  }).probe();
  assert.equal(unavailable.state, "incompatible");
  assert.equal(unavailable.diagnostic?.code, "app_server_unavailable");

  const available = await createCodexInstallation({
    platform: "linux",
    resolve: () => "/bin/codex",
    exists: () => true,
    now: () => 0,
    run: success,
  }).probe();
  assert.equal(available.state, "available");
  assert.equal(available.version, "runtime 1.2.3");
});

test("claude installation reports absence and version evidence", async () => {
  const absent = await createClaudeInstallation({ resolve: () => null, now: () => 0 }).probe();
  assert.equal(absent.state, "not_installed");

  const available = await createClaudeInstallation({
    resolve: () => "/bin/claude",
    now: () => 0,
    run: success,
  }).probe();
  assert.equal(available.state, "available");
  assert.equal(available.source, "path");
});
