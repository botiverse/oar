import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeInstallation } from "../packages/oar/src/runtimes/claude/installation.js";
import { createCodexInstallation } from "../packages/oar/src/runtimes/codex/installation.js";
import type { ExecutableRunner } from "../packages/oar/src/shared/executable/index.js";

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
    run: async () => ({ ok: false, stdout: "", stderr: "", exitCode: 1 }),
  }).probe();
  assert.equal(unavailable.kind, "unsupported");
  assert.equal(unavailable.reason, "app_server_unavailable");

  const available = await createCodexInstallation({
    platform: "linux",
    resolve: () => "/bin/codex",
    exists: () => true,
    run: success,
  }).probe();
  assert.equal(available.kind, "available");
  assert.equal(available.version, "runtime 1.2.3");
});

test("claude installation reports absence and version evidence", async () => {
  const absent = await createClaudeInstallation({ resolve: () => null }).probe();
  assert.equal(absent.kind, "not_found");

  const available = await createClaudeInstallation({
    resolve: () => "/bin/claude",
    run: success,
  }).probe();
  assert.equal(available.kind, "available");
});

test("installation probes reject operational failures", async () => {
  await assert.rejects(createCodexInstallation({
    platform: "linux",
    resolve: () => "/bin/codex",
    exists: () => true,
    run: async () => ({ ok: false, stdout: "", stderr: "", exitCode: null }),
  }).probe(), /Codex app-server/u);

  await assert.rejects(createClaudeInstallation({
    resolve: () => "/bin/claude",
    run: async () => ({ ok: false, stdout: "", stderr: "", exitCode: null }),
  }).probe(), /Claude installation version/u);
});
