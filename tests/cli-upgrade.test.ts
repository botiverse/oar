import assert from "node:assert/strict";
import { test } from "vitest";
import { readUpgrade, renderUpgradeReport, upgradeFailed } from "../packages/cli/src/upgrade.js";

// The CLI resolves `@botiverse/oar` to the built package, so fixtures take
// their shapes from the CLI function under test.
type Runtime = Parameters<typeof readUpgrade>[0];
type AvailableInstallation = Parameters<NonNullable<Runtime["checkUpdate"]>>[0];
type UpdateCheck = Awaited<ReturnType<NonNullable<Runtime["checkUpdate"]>>>;

const executable: AvailableInstallation = { kind: "available", via: "executable", command: "/bin/fake", version: "1.0.0" };

const neverSession: Runtime["session"] = async () => {
  await Promise.resolve();
  throw new Error("not exercised");
};

const noInventory = async () => ({
  kind: "unsupported" as const,
  code: "native_query_unavailable" as const,
  reason: "not exercised",
});

function runtime(id: string, extra: Partial<Runtime>, installation: AvailableInstallation = executable): Runtime {
  return {
    skills: noInventory,
    mcpServers: noInventory,
    tools: noInventory,
    id,
    brand: { name: id, icon: null },
    session: neverSession,
    installation: async () => {
      await Promise.resolve();
      return installation;
    },
    ...extra,
  };
}

const newer: UpdateCheck = { kind: "ok", installed: "1.0.0", latest: "1.1.0", updateAvailable: true, channel: "stable", source: "fake update --check" };

test("--check reports the runtime's own check without upgrading", async () => {
  let upgraded = false;
  const report = await readUpgrade(runtime("fake", {
    checkUpdate: async () => {
      await Promise.resolve();
      return newer;
    },
    upgrade: async () => {
      await Promise.resolve();
      upgraded = true;
      return { kind: "upgraded", from: "1.0.0", to: "1.1.0", output: "" };
    },
  }), { upgrade: false });
  assert.equal(upgraded, false);
  assert.deepEqual(renderUpgradeReport(report), ["fake\t1.0.0 -> 1.1.0 available (stable channel, fake update --check)"]);
});

test("a check that sees an older release than the installed one says no update", () => {
  const behind: UpdateCheck = { kind: "ok", installed: "1.3.0", latest: "1.2.1", updateAvailable: false, source: "registry" };
  assert.deepEqual(renderUpgradeReport({ runtimeId: "agy", check: behind }), ["agy\t1.3.0, no update (source lists 1.2.1, registry)"]);
});

test("an upgrade that did not move the version prints the updater's words and fails the command", async () => {
  const report = await readUpgrade(runtime("fake", {
    checkUpdate: async () => {
      await Promise.resolve();
      return newer;
    },
    upgrade: async () => {
      await Promise.resolve();
      return { kind: "unchanged", version: "1.0.0", output: "Detected install source: unsupported\nTo update manually, run: npm i -g fake\n" };
    },
  }), { upgrade: true });
  assert.deepEqual(renderUpgradeReport(report), [
    "fake\tstill 1.0.0 after the updater ran; its output:",
    "  Detected install source: unsupported",
    "  To update manually, run: npm i -g fake",
  ]);
  assert.equal(upgradeFailed(report), true);
});

test("runtimes without an updater still show their check; bundled ones say why there is none", async () => {
  const checkOnly = await readUpgrade(runtime("agy", {
    checkUpdate: async () => {
      await Promise.resolve();
      return newer;
    },
  }), { upgrade: true });
  assert.equal(checkOnly.unsupported, "agy has no updater oar can run");
  assert.equal(upgradeFailed(checkOnly), false);
  const bundled = await readUpgrade(runtime("pi", {}, { kind: "available", via: "bundled" }), { upgrade: true });
  assert.deepEqual(renderUpgradeReport(bundled), ["pi\tpi is bundled with oar and moves with the oar version"]);
});
