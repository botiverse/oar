import assert from "node:assert/strict";
import test from "node:test";
import { claudeInstallation } from "../packages/oar/src/runtimes/claude/installation.js";
import { codexInstallation } from "../packages/oar/src/runtimes/codex/installation.js";
import { executableInstallation } from "../packages/oar/src/shared/installation.js";

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

test("executable installation resolves bare names on PATH", async () => {
  const onPath = await executableInstallation("OAR_FIXTURE_BIN", "node").probe();
  assert.deepEqual(onPath, { kind: "available", version: process.version });

  const absent = await executableInstallation("OAR_FIXTURE_BIN", "oar-fixture-missing").probe();
  assert.equal(absent.kind, "not_found");
});

test("a missing fallback path contributes no candidate", async () => {
  const snapshot = await executableInstallation(
    "OAR_FIXTURE_BIN",
    "oar-fixture-missing",
    ["/nonexistent/oar-fixture", process.execPath],
  ).probe();
  assert.deepEqual(snapshot, { kind: "available", version: process.version });
});

test("a pinned env var is exclusive and must exist as given", async () => {
  const installation = executableInstallation("OAR_FIXTURE_BIN", "node");
  const pinnedMissing = await withEnv(
    { OAR_FIXTURE_BIN: "/nonexistent/oar-fixture" },
    async () => installation.probe(),
  );
  assert.equal(pinnedMissing.kind, "not_found");

  const pinned = await withEnv(
    { OAR_FIXTURE_BIN: process.execPath },
    async () => installation.probe(),
  );
  assert.deepEqual(pinned, { kind: "available", version: process.version });
});

test("readiness gates each candidate", async () => {
  const ready = await executableInstallation(
    "OAR_FIXTURE_BIN",
    "node",
    [],
    ["--version"],
  ).probe();
  assert.deepEqual(ready, { kind: "available", version: process.version });

  // Node rejects the app-server-style subcommand, so the probe is unsupported.
  const unsupported = await executableInstallation(
    "OAR_FIXTURE_BIN",
    "node",
    [],
    ["oar-fixture-subcommand", "--help"],
  ).probe();
  assert.deepEqual(unsupported, {
    kind: "unsupported",
    reason: "oar-fixture-subcommand --help failed",
  });
});

test("claude and codex probe through their pin env vars", async () => {
  const claude = await withEnv(
    { OAR_CLAUDE_BIN: process.execPath },
    async () => claudeInstallation.probe(),
  );
  assert.deepEqual(claude, { kind: "available", version: process.version });

  const codex = await withEnv(
    { OAR_CODEX_BIN: process.execPath },
    async () => codexInstallation.probe(),
  );
  assert.deepEqual(codex, { kind: "unsupported", reason: "app-server --help failed" });
});
