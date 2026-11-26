import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { UnsupportedOptionError } from "../../../packages/oar/src/contracts/errors.js";
import { ModelConfirmationError } from "../../../packages/oar/src/contracts/model-confirmation-error.js";
import { createDimRuntime } from "../../../packages/oar/src/community/dim/index.js";
import { daemonLogTail, dimDaemonArgs } from "../../../packages/oar/src/community/dim/daemon.js";
import { readDimVersion } from "../../../packages/oar/src/community/dim/installation.js";
import { checkDimLaunchArgs } from "../../../packages/oar/src/community/dim/options.js";
import { dimConfigureModel, hasDimModelOption } from "../../../packages/oar/src/community/dim/model.js";
import { dimAcpProfile, dimFailureOutcome, dimSession, needsDimFullAccess } from "../../../packages/oar/src/community/dim/session.js";
import type { JsonRecord } from "../../../packages/oar/src/shared/json.js";

// Shapes below are from dimcode 0.1.0-alpha.29 (experiments/dim-acp-probe.ts).

test("the version reader takes dimcode's semver, prereleases included", () => {
  assert.equal(readDimVersion("dimcode 0.1.0-alpha.29\n"), "0.1.0-alpha.29");
  assert.equal(readDimVersion("dimcode 1.2.3"), "1.2.3");
  assert.equal(readDimVersion("dim 0.1.0"), undefined);
});

test("launchArgs may choose the home, server and model config but not what OAR owns", () => {
  checkDimLaunchArgs(["--home", "/h", "--model-config", "/m.json", "--server", "ws://127.0.0.1:1"]);
  for (const flag of ["acp", "--model", "--model=x", "--effort", "--permission", "--resume", "--cwd", "-p"]) {
    expect(() => { checkDimLaunchArgs([flag]); }, flag).toThrow(UnsupportedOptionError);
  }
});

test("the App Server selection is read from launchArgs in both spellings", () => {
  assert.deepEqual(dimDaemonArgs(undefined), []);
  assert.deepEqual(
    dimDaemonArgs(["--agent", "a", "--home", "/h", "--model-config=/m.json", "--server", "ws://s"]),
    ["--home", "/h", "--model-config=/m.json", "--server", "ws://s"],
  );
});

const modes = (current: string): JsonRecord => ({ modes: { currentModeId: current, availableModes: [{ id: "read-only" }, { id: "workspace-write" }, { id: "full-access" }] } });

test("full-access is requested only when offered and not already current", () => {
  assert.equal(needsDimFullAccess(modes("workspace-write")), true);
  assert.equal(needsDimFullAccess(modes("full-access")), false);
  assert.equal(needsDimFullAccess({}), false);
});

const catalogResponse: JsonRecord = {
  configOptions: [{ id: "model", category: "model", type: "select", currentValue: "gpt-4o", options: [{ value: "gpt-4o" }, { value: "gpt-4o-mini" }] }],
};

test("a model is refused without Dim's model option, before any request", async () => {
  assert.equal(hasDimModelOption(catalogResponse), true);
  assert.equal(hasDimModelOption({ configOptions: [] }), false);
  const calls: string[] = [];
  await expect(dimConfigureModel({
    options: { cwd: "/", model: "gpt-4o-mini" },
    response: { configOptions: [] },
    setModel: async (model) => { calls.push(model); return undefined; },
    setEffort: async () => ({}),
  })).rejects.toThrow(UnsupportedOptionError);
  assert.deepEqual(calls, []);
});

const answer = (value: string): JsonRecord => ({ configOptions: [{ id: "model", currentValue: value }] });

test("a model must be confirmed by the option's currentValue", async () => {
  const applied = await dimConfigureModel({
    options: { cwd: "/", model: "gpt-4o-mini" },
    response: catalogResponse,
    setModel: async (model) => answer(model),
    setEffort: async () => ({}),
  });
  assert.deepEqual(applied, answer("gpt-4o-mini"));
  await expect(dimConfigureModel({
    options: { cwd: "/", model: "gpt-4o-mini" },
    response: catalogResponse,
    setModel: async () => answer("gpt-4o"),
    setEffort: async () => ({}),
  })).rejects.toThrow(/left model at gpt-4o/u);
});

test("only Dim's not-found code reads as a missing session", () => {
  assert.equal(dimAcpProfile.isResumeNotFound?.({ code: -32_002, message: "Resource not found" }), true);
  assert.equal(dimAcpProfile.isResumeNotFound?.({ code: -32_001, message: "Session cwd does not match expectedCwd" }), false);
});

test("the brand is the distributed asset, inline", () => {
  const { brand } = createDimRuntime();
  assert.ok(brand.icon?.startsWith("data:image/svg+xml,") === true);
  const svg = decodeURIComponent(brand.icon.slice("data:image/svg+xml,".length));
  assert.equal(svg, readFileSync(new URL("../../../packages/oar/assets/brands/dim.svg", import.meta.url), "utf8"));
  assert.doesNotMatch(svg, /currentColor|<script|<foreignObject|\son\w+=|(?:href|src)=/iu);
});

test("Dim's credential failures are auth failures that say whether the key was missing or refused", () => {
  const failed = (message: string) => dimFailureOutcome(Object.assign(new Error(message), { code: -32_001, data: { code: "turn_failed" } }), []);
  expect(failed("Missing credential environment variable: DEEPSEEK_API_KEY")).toMatchObject({ failure: "auth", credential: "missing" });
  expect(failed("The provider rejected the credentials: Authentication Fails, Your api key: ****0000 is invalid")).toMatchObject({ failure: "auth", credential: "rejected" });
  assert.equal(failed("Session or gateway is busy"), null);
});

test("an App Server that exits at start is explained by the last line of the log it names", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-dim-log-"));
  try {
    const log = path.join(dir, "daemon.log");
    writeFileSync(log, `${"x".repeat(10_000)}\nstarting\nError: compatible.preset requires openai-compatible\n`);
    assert.equal(await daemonLogTail(`Error: App Server exited (exit status: 1); see ${log}`), "Error: compatible.preset requires openai-compatible");
    assert.equal(await daemonLogTail("Error: connection refused"), "");
    assert.equal(await daemonLogTail(`see ${path.join(dir, "absent", "daemon.log")}`), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fake `dima` whose failing `runtime list` echoes the session's key on stderr and in the log it names.
function failingDima(dir: string): string {
  const command = path.join(dir, "dima");
  const log = path.join(dir, "a home", "daemon.log");
  writeFileSync(command, `#!${process.execPath}
const fs = require("node:fs");
fs.mkdirSync(${JSON.stringify(path.dirname(log))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(log)}, "Error: provider rejected " + process.env.DEEPSEEK_API_KEY + "\\n");
fs.writeFileSync(${JSON.stringify(path.join(dir, "started"))}, "");
process.stderr.write("Error: key " + process.env.DEEPSEEK_API_KEY + " App Server exited (exit status: 1); see ${log}\\n");
process.exit(1);
`);
  chmodSync(command, 0o755);
  return command;
}

test.skipIf(process.platform === "win32")("a failed App Server start redacts the session's credentials from stderr and the log", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-dim-redact-"));
  const key = "sk-test-0123456789abcdef0123456789";
  try {
    const opening = dimSession({ kind: "available", via: "executable", command: failingDima(dir), version: "0.1.0-alpha.29" }, { cwd: dir, env: { DEEPSEEK_API_KEY: key } });
    const error = await opening.then(() => null, (rejection: unknown) => rejection);
    assert.ok(error instanceof Error);
    expect(error.message).toContain("[redacted] App Server exited");
    expect(error.message).toContain("Error: provider rejected [redacted]");
    expect(`${error.message}${error.stack ?? ""}`).not.toContain(key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("an invalid MCP server name is refused before an App Server starts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-dim-mcp-"));
  try {
    const opening = dimSession({ kind: "available", via: "executable", command: failingDima(dir), version: "0.1.0-alpha.29" }, { cwd: dir, mcpServers: [{ name: "", command: "x" }] });
    await expect(opening).rejects.toThrow("empty name");
    assert.equal(existsSync(path.join(dir, "started")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a model the option does not confirm is a ModelConfirmationError", async () => {
  const response = { configOptions: [{ id: "model", category: "model", currentValue: "a", options: [{ value: "a" }, { value: "b" }] }] };
  const opening = dimConfigureModel({ options: { cwd: "/w", model: "b" }, response, setModel: async () => response, setEffort: async () => ({}) });
  await expect(opening).rejects.toBeInstanceOf(ModelConfirmationError);
  await expect(opening).rejects.toMatchObject({ requested: "b", reported: "a" });
});
