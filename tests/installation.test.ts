import assert from "node:assert/strict";
import { test } from "vitest";
import { claudeInstallation } from "../packages/oar/src/runtimes/claude/installation.js";
import { codexInstallation } from "../packages/oar/src/runtimes/codex/installation.js";
import {
  grokInstallation,
  grokInstalledExecutableCandidates,
} from "../packages/oar/src/runtimes/grok/installation.js";
import {
  kimiInstallation,
  kimiInstalledExecutableCandidates,
} from "../packages/oar/src/runtimes/kimi/installation.js";
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

test("executable installation evaluates fallback factories at probe time", async () => {
  let fallback = "/nonexistent/oar-fixture";
  const installation = executableInstallation(
    "OAR_FIXTURE_BIN",
    "oar-fixture-missing",
    () => [fallback],
  );
  fallback = process.execPath;

  assert.deepEqual(await installation(), {
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

test("a pinned env var does not evaluate fallback factories", async () => {
  let evaluated = false;
  const installation = executableInstallation(
    "OAR_FIXTURE_BIN",
    "node",
    () => {
      evaluated = true;
      return [];
    },
  );
  const snapshot = await withEnv(
    { OAR_FIXTURE_BIN: process.execPath },
    async () => installation(),
  );

  assert.equal(evaluated, false);
  assert.deepEqual(snapshot, {
    kind: "available",
    via: "executable",
    command: process.execPath,
    version: process.version,
  });
});

test("grok candidates match the official script and npm layouts", () => {
  assert.deepEqual(
    grokInstalledExecutableCandidates("linux", "/home/oar", {
      GROK_BIN_DIR: "/opt/grok-cli",
      GROK_HOME: "/var/lib/grok",
    }),
    [
      "/opt/grok-cli/grok",
      "/var/lib/grok/bin/grok",
      "/home/oar/.grok/bin/grok",
    ],
  );
  assert.deepEqual(
    grokInstalledExecutableCandidates("win32", String.raw`C:\Users\oar`, {
      GROK_BIN_DIR: String.raw`D:\Grok CLI`,
      GROK_HOME: String.raw`D:\Grok Home`,
    }),
    [
      String.raw`D:\Grok CLI\grok.exe`,
      String.raw`D:\Grok Home\bin\grok.exe`,
      String.raw`C:\Users\oar\.grok\bin\grok.exe`,
    ],
  );
});

test("kimi candidates match the official native-installer layouts", () => {
  assert.deepEqual(
    kimiInstalledExecutableCandidates("darwin", "/Users/oar", {
      KIMI_INSTALL_DIR: "/opt/kimi-code",
    }),
    [
      "/opt/kimi-code/bin/kimi",
      "/Users/oar/.kimi-code/bin/kimi",
      "kimi-code",
    ],
  );
  assert.deepEqual(
    kimiInstalledExecutableCandidates("win32", String.raw`C:\Users\oar`, {
      KIMI_INSTALL_DIR: String.raw`D:\Kimi Code`,
    }),
    [
      String.raw`D:\Kimi Code\bin\kimi.exe`,
      String.raw`C:\Users\oar\.kimi-code\bin\kimi.exe`,
      "kimi-code",
    ],
  );
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

test("grok and kimi gate their ACP entrypoints", async () => {
  const grok = await withEnv(
    { OAR_GROK_BIN: process.execPath },
    async () => grokInstallation(),
  );
  assert.deepEqual(grok, { kind: "unsupported", reason: "agent stdio --help failed" });

  const kimi = await withEnv(
    { OAR_KIMI_BIN: process.execPath },
    async () => kimiInstallation(),
  );
  assert.deepEqual(kimi, { kind: "unsupported", reason: "acp --help failed" });
});

test("pi installation reports a versionless bundled availability", async () => {
  const snapshot = await piInstallation();
  assert.deepEqual(snapshot, { kind: "available", via: "bundled" });
});
