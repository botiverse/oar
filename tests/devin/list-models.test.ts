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

function sampleConfigOptions(): readonly Record<string, unknown>[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "claude-sonnet-4-5",
      options: [
        { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { value: "gpt-5", name: "GPT-5" },
      ],
    },
    {
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("devinListModels projects model + thought_level configOptions and calls session/close", async () => {
  const { command, log } = writeFakeDevinCli();
  const result = await devinListModels(
    { kind: "available", via: "executable", command, version: "3000.12.57" },
    {
      env: {
        FAKE_DEVIN_CALL_LOG: log,
        FAKE_DEVIN_SESSION_ID: "devin-list-1",
        FAKE_DEVIN_CONFIG_OPTIONS: JSON.stringify(sampleConfigOptions()),
      },
    },
  );
  expect(result).toEqual({
    kind: "ok",
    models: [
      {
        id: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5",
        default: true,
        effortLevels: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
      { id: "gpt-5", displayName: "GPT-5" },
    ],
  });
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "initialize",
    "session/new",
    "session/close",
    "close:devin-list-1",
  ]);
});

test("devinListModels falls back to devin auth status when options is empty and maps logged_out to unauthenticated", async () => {
  const { command, log } = writeFakeDevinCli();
  const configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "",
      options: [],
    },
  ];
  const result = await devinListModels(
    { kind: "available", via: "executable", command, version: "3000.12.57" },
    {
      env: {
        WINDSURF_API_KEY: null,
        FAKE_DEVIN_CALL_LOG: log,
        FAKE_DEVIN_SESSION_ID: "devin-list-1",
        FAKE_DEVIN_CONFIG_OPTIONS: JSON.stringify(configOptions),
        FAKE_DEVIN_AUTH_STDOUT: "Not logged in.\nRun `devin auth login` to authenticate.\n",
      },
    },
  );
  expect(result).toEqual({
    kind: "unauthenticated",
    detail: "Run `devin auth login` in a terminal or set WINDSURF_API_KEY.",
  });
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "initialize",
    "session/new",
    "session/close",
    "close:devin-list-1",
    "auth status",
  ]);
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
