import assert from "node:assert/strict";
import { test } from "vitest";
import { readModels, renderModels } from "../packages/cli/src/models.js";

// The CLI resolves `@botiverse/oar` to the built package, whose branded types
// are not identical to the src ones, so fixtures take their shapes from the
// CLI function under test rather than from the library source.
type Runtime = Parameters<typeof readModels>[0];
type AvailableInstallation = Parameters<NonNullable<Runtime["listModels"]>>[0];

const available: AvailableInstallation = { kind: "available", via: "bundled" };

const neverSession: Runtime["session"] = async () => {
  await Promise.resolve();
  throw new Error("not exercised");
};

test("readModels reports unsupported when the runtime has no listModels", async () => {
  const runtime: Runtime = {
    id: "bare",
    session: neverSession,
    installation: async () => {
      await Promise.resolve();
      return available;
    },
  };
  const report = await readModels(runtime);
  assert.equal(report.runtimeId, "bare");
  assert.equal(report.installation, undefined);
  assert.equal(report.models?.kind, "unsupported");
  assert.deepEqual(renderModels(report), ["bare: unsupported (bare exposes no listModels capability)"]);
});

test("readModels echoes the installation and null models when not available", async () => {
  const runtime: Runtime = {
    id: "gone",
    session: neverSession,
    installation: async () => {
      await Promise.resolve();
      return { kind: "not_found" as const };
    },
    listModels: async () => {
      await Promise.resolve();
      throw new Error("must not be called");
    },
  };
  const report = await readModels(runtime);
  assert.deepEqual(report, {
    runtimeId: "gone",
    installation: { kind: "not_found" },
    models: null,
  });
  assert.deepEqual(renderModels(report), ["gone: not available (not_found)"]);
});

test("readModels forwards the installation and timeout to listModels", async () => {
  const seen: unknown[] = [];
  const runtime: Runtime = {
    id: "ok",
    session: neverSession,
    installation: async () => {
      await Promise.resolve();
      return available;
    },
    listModels: async (installation, options) => {
      seen.push(installation, options);
      await Promise.resolve();
      return {
        kind: "ok",
        models: [
          { id: "sonnet", resolvedId: "claude-sonnet-5", displayName: "Sonnet" },
          { id: "fast", effortLevels: ["low", "high"], defaultEffort: "high" },
          { id: "old", disabled: { reason: "plan does not include it" } },
        ],
      };
    },
  };
  const report = await readModels(runtime, { timeoutMs: 1500 });
  assert.deepEqual(seen, [available, { timeoutMs: 1500 }]);
  assert.deepEqual(renderModels(report), [
    'ok\tsonnet -> claude-sonnet-5 "Sonnet"',
    "ok\tfast [low,high*]",
    "ok\told (disabled: plan does not include it)",
  ]);
});

test("renderModels distinguishes unauthenticated from an empty list", () => {
  assert.deepEqual(
    renderModels({ runtimeId: "r", models: { kind: "unauthenticated", detail: "run r login" } }),
    ["r: not logged in (run r login)"],
  );
  assert.deepEqual(renderModels({ runtimeId: "r", models: { kind: "unauthenticated" } }), ["r: not logged in"]);
  assert.deepEqual(renderModels({ runtimeId: "r", models: { kind: "ok", models: [] } }), ["r: no models"]);
});
