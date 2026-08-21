import assert from "node:assert/strict";
import test from "node:test";
import { createExecutableInstallation } from "../packages/oar/src/installation.js";

test("executable installation reports absence and version evidence", async () => {
  const absent = await createExecutableInstallation({
    label: "fixture",
    command: "oar-command-that-does-not-exist",
  }).probe();
  assert.equal(absent.kind, "not_found");

  const available = await createExecutableInstallation({
    label: "fixture",
    command: process.execPath,
  }).probe();
  assert.equal(available.kind, "available");
  assert.equal(available.version, process.version);
});

test("executable installation applies an optional readiness probe", async () => {
  const available = await createExecutableInstallation({
    label: "fixture",
    command: process.execPath,
    readiness: {
      args: ["--version"],
      unsupportedReason: "fixture_unavailable",
    },
  }).probe();
  assert.equal(available.kind, "available");

  const unsupported = await createExecutableInstallation({
    label: "fixture",
    command: process.execPath,
    readiness: {
      args: ["--oar-invalid-option"],
      unsupportedReason: "fixture_unavailable",
    },
  }).probe();
  assert.deepEqual(unsupported, {
    kind: "unsupported",
    reason: "fixture_unavailable",
  });
});
