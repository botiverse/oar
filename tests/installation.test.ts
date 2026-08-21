import assert from "node:assert/strict";
import test from "node:test";
import { claudeInstallation } from "../packages/oar/src/runtimes/claude/installation.js";
import { codexInstallation } from "../packages/oar/src/runtimes/codex/installation.js";
import { probeExecutableInstallation } from "../packages/oar/src/shared/installation.js";

async function withEnv<T>(
  overrides: Record<string, string>,
  body: () => Promise<T>,
): Promise<T> {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("probe resolves bare names on PATH and rejects missing pinned paths", async () => {
  const onPath = await probeExecutableInstallation(["node"]);
  assert.deepEqual(onPath, { kind: "available", version: process.version });

  // A missing pinned path contributes no candidate; later candidates are still tried.
  const pinned = await probeExecutableInstallation(["/nonexistent/oar-fixture", "node"]);
  assert.deepEqual(pinned, { kind: "available", version: process.version });

  const absent = await probeExecutableInstallation(["oar-fixture-that-does-not-exist"]);
  assert.equal(absent.kind, "not_found");
});

test("claude installation honors OAR_CLAUDE_BIN", async () => {
  const absent = await withEnv(
    { OAR_CLAUDE_BIN: "/nonexistent/oar-fixture-claude" },
    async () => claudeInstallation.probe(),
  );
  assert.equal(absent.kind, "not_found");

  const available = await withEnv(
    { OAR_CLAUDE_BIN: process.execPath },
    async () => claudeInstallation.probe(),
  );
  assert.deepEqual(available, { kind: "available", version: process.version });
});

test("codex installation requires the app-server surface", async () => {
  const absent = await withEnv(
    { OAR_CODEX_BIN: "/nonexistent/oar-fixture-codex" },
    async () => codexInstallation.probe(),
  );
  assert.equal(absent.kind, "not_found");

  // Node rejects the app-server subcommand, so a non-codex executable is unsupported.
  const unsupported = await withEnv(
    { OAR_CODEX_BIN: process.execPath },
    async () => codexInstallation.probe(),
  );
  assert.deepEqual(unsupported, { kind: "unsupported", reason: "app_server_unavailable" });
});
