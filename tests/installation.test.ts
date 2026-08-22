import assert from "node:assert/strict";
import { test } from "vitest";
import { claudeInstallation } from "../packages/oar/src/runtimes/claude/installation.js";
import { codexInstallation } from "../packages/oar/src/runtimes/codex/installation.js";
import { resolveExecutable } from "../packages/oar/src/shared/executable/index.js";
import { executableInstallation } from "../packages/oar/src/shared/installation.js";
import { piInstallation } from "../packages/oar/src/runtimes/pi/installation.js";

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

const nodeOnPath = resolveExecutable("node");

test("executable installation resolves bare names on PATH", async () => {
  const onPath = await executableInstallation("OAR_FIXTURE_BIN", "node")();
  assert.deepEqual(onPath, { kind: "available", via: "executable", command: nodeOnPath, version: process.version });

  const absent = await executableInstallation("OAR_FIXTURE_BIN", "oar-fixture-missing")();
  assert.equal(absent.kind, "not_found");
});

test("a missing fallback path contributes no candidate", async () => {
  const snapshot = await executableInstallation(
    "OAR_FIXTURE_BIN",
    "oar-fixture-missing",
    ["/nonexistent/oar-fixture", process.execPath],
  )();
  assert.deepEqual(snapshot, {
    kind: "available",
    via: "executable",
    command: process.execPath,
    version: process.version,
  });
});

test("a pinned env var is exclusive and must exist as given", async () => {
  const installation = executableInstallation("OAR_FIXTURE_BIN", "node");
  const pinnedMissing = await withEnv(
    { OAR_FIXTURE_BIN: "/nonexistent/oar-fixture" },
    async () => installation(),
  );
  assert.equal(pinnedMissing.kind, "not_found");

  const pinned = await withEnv(
    { OAR_FIXTURE_BIN: process.execPath },
    async () => installation(),
  );
  assert.deepEqual(pinned, {
    kind: "available",
    via: "executable",
    command: process.execPath,
    version: process.version,
  });
});

test("readiness gates each candidate", async () => {
  const ready = await executableInstallation(
    "OAR_FIXTURE_BIN",
    "node",
    [],
    ["--version"],
  )();
  assert.deepEqual(ready, { kind: "available", via: "executable", command: nodeOnPath, version: process.version });

  // Node rejects the app-server-style subcommand, so the probe is unsupported.
  const unsupported = await executableInstallation(
    "OAR_FIXTURE_BIN",
    "node",
    [],
    ["oar-fixture-subcommand", "--help"],
  )();
  assert.deepEqual(unsupported, {
    kind: "unsupported",
    reason: "oar-fixture-subcommand --help failed",
  });
});

test("claude and codex probe through their pin env vars", async () => {
  const claude = await withEnv(
    { OAR_CLAUDE_BIN: process.execPath },
    async () => claudeInstallation(),
  );
  assert.deepEqual(claude, {
    kind: "available",
    via: "executable",
    command: process.execPath,
    version: process.version,
  });

  const codex = await withEnv(
    { OAR_CODEX_BIN: process.execPath },
    async () => codexInstallation(),
  );
  assert.deepEqual(codex, { kind: "unsupported", reason: "app-server --help failed" });
});

test("pi installation reports a versionless bundled availability", async () => {
  const snapshot = await piInstallation();
  assert.deepEqual(snapshot, { kind: "available", via: "bundled" });
});
