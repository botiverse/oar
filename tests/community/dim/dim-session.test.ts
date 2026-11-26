import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { UnsupportedOptionError } from "../../../packages/oar/src/contracts/errors.js";
import { dimDaemonArgs } from "../../../packages/oar/src/community/dim/daemon.js";
import { readDimVersion } from "../../../packages/oar/src/community/dim/installation.js";
import { checkDimLaunchArgs } from "../../../packages/oar/src/community/dim/options.js";
import { dimAcpProfile, dimConfigureModel, hasDimModelOption, needsDimFullAccess } from "../../../packages/oar/src/community/dim/session.js";
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
