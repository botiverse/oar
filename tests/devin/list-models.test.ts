import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { devinListModels } from "../../packages/oar/src/runtimes/devin/list-models.js";

const tempDirs: string[] = [];
const fakeDevinScript = fileURLToPath(new URL("../fixtures/fake-acp-devin.mjs", import.meta.url));

function writeExecutable(dir: string): string {
  if (process.platform === "win32") {
    const cmd = path.join(dir, "devin.cmd");
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${fakeDevinScript}" %*\r\n`);
    return cmd;
  }
  const bin = path.join(dir, "devin");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeDevinScript}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function writeFakeDevinCli(): { readonly command: string; readonly log: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-devin-models-"));
  tempDirs.push(dir);
  return { command: writeExecutable(dir), log: path.join(dir, "calls.txt") };
}

function emptyModelConfigOptions(): readonly Record<string, unknown>[] {
  return [
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: "swe-1-6-fast",
      options: [],
    },
  ];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("devinListModels projects realistic model + thought_level configOptions and prefers session/delete", async () => {
  const { command, log } = writeFakeDevinCli();
  const result = await devinListModels(
    { kind: "available", via: "executable", command, version: "3000.12.57" },
    {
      env: {
        FAKE_DEVIN_CALL_LOG: log,
        FAKE_DEVIN_SESSION_ID: "devin-list-1",
      },
    },
  );
  expect(result).toEqual({
    kind: "ok",
    models: [
      {
        id: "swe-1-6-fast",
        displayName: "SWE-1.6 Fast",
        default: true,
        effortLevels: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
      { id: "swe-1-6", displayName: "SWE-1.6" },
    ],
  });
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "initialize",
    "session/new",
    "session/delete",
    "delete:devin-list-1",
  ]);
});

test("devinListModels falls back to session/close when sessionCapabilities.delete is absent", async () => {
  const { command, log } = writeFakeDevinCli();
  const result = await devinListModels(
    { kind: "available", via: "executable", command, version: "3000.12.57" },
    {
      env: {
        FAKE_DEVIN_CALL_LOG: log,
        FAKE_DEVIN_SESSION_ID: "devin-list-close",
        FAKE_DEVIN_SESSION_CAPABILITIES: JSON.stringify({ list: {}, close: {} }),
      },
    },
  );
  expect(result.kind).toBe("ok");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "initialize",
    "session/new",
    "session/close",
    "close:devin-list-close",
  ]);
});

test("devinListModels maps empty options to unauthenticated when logged_out and ok when logged_in", async () => {
  const { command, log } = writeFakeDevinCli();
  const emptyJson = JSON.stringify(emptyModelConfigOptions());
  const installation = { kind: "available", via: "executable", command, version: "3000.12.57" } as const;

  const loggedOut = await devinListModels(installation, {
    env: {
      WINDSURF_API_KEY: null,
      FAKE_DEVIN_CALL_LOG: log,
      FAKE_DEVIN_SESSION_ID: "devin-list-1",
      FAKE_DEVIN_CONFIG_OPTIONS: emptyJson,
      FAKE_DEVIN_AUTH_STDOUT: "Not logged in.\n  Credentials path: /tmp/devin-probe/data/devin/credentials.toml\nRun `devin auth login` to authenticate.\n",
    },
  });
  expect(loggedOut).toEqual({
    kind: "unauthenticated",
    detail: "Run `devin auth login` in a terminal or set WINDSURF_API_KEY.",
  });
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "initialize",
    "session/new",
    "session/delete",
    "delete:devin-list-1",
    "auth status",
  ]);

  const loggedIn = await devinListModels(installation, {
    env: {
      WINDSURF_API_KEY: null,
      FAKE_DEVIN_CONFIG_OPTIONS: emptyJson,
      FAKE_DEVIN_AUTH_STDOUT: "Logged in (via Devin).\n",
    },
  });
  expect(loggedIn).toEqual({ kind: "ok", models: [] });
});

test("devinListModels maps empty options with unknown auth to unsupported when configured and rejects when unconfigured", async () => {
  const { command } = writeFakeDevinCli();
  const emptyJson = JSON.stringify(emptyModelConfigOptions());
  const installation = { kind: "available", via: "executable", command, version: "3000.12.57" } as const;

  const envConfigured = await devinListModels(installation, {
    env: {
      WINDSURF_API_KEY: "sk-unverified-windsurf-key",
      FAKE_DEVIN_CONFIG_OPTIONS: emptyJson,
    },
  });
  expect(envConfigured).toEqual({
    kind: "unsupported",
    reason: "WINDSURF_API_KEY is configured; devin auth status inspects stored login credentials and does not validate this environment key.",
  });

  const unverifiedStored = await devinListModels(installation, {
    env: {
      WINDSURF_API_KEY: null,
      FAKE_DEVIN_CONFIG_OPTIONS: emptyJson,
      FAKE_DEVIN_AUTH_STDOUT: "Logged in (via Devin).\n\nUser / team info:\n  Unavailable: offline\n",
    },
  });
  expect(unverifiedStored).toEqual({
    kind: "unsupported",
    reason: "devin auth status found stored credentials and could not verify them with the server",
  });

  await expect(
    devinListModels(installation, {
      env: {
        WINDSURF_API_KEY: null,
        FAKE_DEVIN_CONFIG_OPTIONS: emptyJson,
        FAKE_DEVIN_AUTH_STDOUT: "Failed to load credentials: TOML parse error at line 1, column 9\n",
      },
    }),
  ).rejects.toThrow(/unreadable stored credentials/u);
});

test("devinListModels enforces one overall timeoutMs across ACP steps and auth status without hanging on runtime.exited", async () => {
  const { command } = writeFakeDevinCli();
  const emptyJson = JSON.stringify(emptyModelConfigOptions());

  // Each step (250ms ACP + 250ms ACP + 250ms delete + 400ms auth) fits inside 600ms individually,
  // yet exceeds the shared 600ms overall deadline together.
  const startedShared = performance.now();
  await expect(
    devinListModels(
      { kind: "available", via: "executable", command, version: "3000.12.57" },
      {
        timeoutMs: 600,
        env: {
          WINDSURF_API_KEY: null,
          FAKE_DEVIN_CONFIG_OPTIONS: emptyJson,
          FAKE_DEVIN_STEP_DELAY_MS: "250",
          FAKE_DEVIN_AUTH_DELAY_MS: "400",
        },
      },
    ),
  ).rejects.toThrow(/timed out/u);
  expect(performance.now() - startedShared).toBeLessThan(1500);

  // Even when the ACP child ignores SIGTERM, timeout settles promptly at timeoutMs without waiting for SIGKILL grace.
  const startedStall = performance.now();
  await expect(
    devinListModels(
      { kind: "available", via: "executable", command, version: "3000.12.57" },
      {
        timeoutMs: 300,
        env: {
          FAKE_DEVIN_IGNORE_SIGTERM: "1",
          FAKE_DEVIN_STALL_METHOD: "session/new",
        },
      },
    ),
  ).rejects.toThrow(/timed out/u);
  expect(performance.now() - startedStall).toBeLessThan(1200);
});

test("devinListModels maps invalid WINDSURF_API_KEY -32603 RequestError to unauthenticated", async () => {
  const { command, log } = writeFakeDevinCli();
  const message = "Failed to load team settings: Failed to fetch team settings: Authentication required: invalid api key";
  const result = await devinListModels(
    { kind: "available", via: "executable", command, version: "3000.12.57" },
    {
      env: {
        FAKE_DEVIN_CALL_LOG: log,
        FAKE_DEVIN_NEW_ERROR: JSON.stringify({ code: -32_603, message }),
      },
    },
  );
  expect(result).toEqual({
    kind: "unauthenticated",
    detail: message,
  });
});
