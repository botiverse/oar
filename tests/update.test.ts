import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { UpdateCheck, UpdateChecker } from "../packages/oar/src/contracts/update.js";
import { codexCheckUpdate } from "../packages/oar/src/runtimes/codex/update.js";
import { kimiUpgrade, kimiUpgrader } from "../packages/oar/src/runtimes/kimi/update.js";
import { comparedCheck, executableUpdate, upgradeExecutable } from "../packages/oar/src/shared/update.js";
import { fakeRuntime as makeFakeRuntime, printingExecutable, type FakeRuntime, type FakeState } from "./fixtures/update-fixtures.js";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oar-update-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Installation = Parameters<typeof upgradeExecutable>[0];

function executable(command: string, version: string): Installation {
  return { kind: "available", via: "executable", command, version };
}

function fakeRuntime(name: string, state: FakeState): FakeRuntime {
  return makeFakeRuntime(dir, name, state);
}

function fixedCheck(check: UpdateCheck): UpdateChecker {
  return async () => {
    await Promise.resolve();
    return check;
  };
}

const available: UpdateCheck = { kind: "ok", installed: "1.0.0", latest: "1.1.0", updateAvailable: true, source: "fixture" };

async function withUserAgent<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = "pnpm/11.22.0";
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = previous;
    }
  }
}

test("an upgrade is judged by the version the same executable reports afterwards", async () => {
  const fake = fakeRuntime("upgrades", { version: "1.0.0", target: "1.1.0", mode: "upgrade" });
  const result = await withUserAgent(async () => {
    const upgrade = await upgradeExecutable(executable(fake.command, "fake 1.0.0"), { check: fixedCheck(available), args: ["update", "--yes"] });
    return upgrade;
  });
  assert.deepEqual(result, { kind: "upgraded", from: "1.0.0", to: "1.1.0", output: "Updated to 1.1.0\n" });
  assert.deepEqual(fake.read().updateArgs, ["--yes"]);
  assert.equal(fake.read().sawUserAgent, false);
});

test("an updater that claims success without moving the version is unchanged, not upgraded", async () => {
  const fake = fakeRuntime("noop", { version: "1.0.0", target: "1.1.0", mode: "noop" });
  const result = await upgradeExecutable(executable(fake.command, "fake 1.0.0"), { check: fixedCheck(available), args: ["update"] });
  assert.deepEqual(result, { kind: "unchanged", version: "1.0.0", output: "Update ran successfully!\n" });
});

test("a failing updater is failed with its exit code and output", async () => {
  const fake = fakeRuntime("fails", { version: "1.0.0", target: "1.1.0", mode: "fail" });
  const result = await upgradeExecutable(executable(fake.command, "fake 1.0.0"), { check: fixedCheck(available), args: ["update"] });
  assert.deepEqual(result, { kind: "failed", exitCode: 3, output: "error: failed to download update\n" });
});

test("an updater that prompts reads end of input instead of waiting", async () => {
  const fake = fakeRuntime("prompts", { version: "1.0.0", target: "1.1.0", mode: "prompt" });
  const started = Date.now();
  const result = await upgradeExecutable(executable(fake.command, "fake 1.0.0"), { check: fixedCheck(available), args: ["update"] }, { timeoutMs: 20_000 });
  assert.equal(result.kind, "unchanged");
  assert.ok(Date.now() - started < 15_000);
});

test("no updater runs when the check says the installation is current", async () => {
  const fake = fakeRuntime("current", { version: "1.1.0", target: "1.1.0", mode: "fail" });
  const current: UpdateCheck = { kind: "ok", installed: "1.1.0", latest: "1.1.0", updateAvailable: false, source: "fixture" };
  const result = await upgradeExecutable(executable(fake.command, "fake 1.1.0"), { check: fixedCheck(current), args: ["update"] });
  assert.deepEqual(result, { kind: "current", version: "1.1.0", check: current });
  assert.equal(fake.read().updateArgs, undefined);
});

/** A check like the runtimes' own: the installed version from the installation, 1.1.0 released. */
const checkFromInstallation: UpdateChecker = async (installation) => {
  await Promise.resolve();
  const update = executableUpdate(installation);
  return update.kind === "executable" ? comparedCheck(update.installed, "1.1.0", "fixture") : update.check;
};

test("an executable that updated itself since its probe is checked and judged by what it says now", async () => {
  // Probed at 1.0.0; the runtime then updated itself in the background (claude's native install does).
  const fake = fakeRuntime("self-updated", { version: "1.1.0", target: "1.1.0", mode: "noop" });
  const result = await upgradeExecutable(executable(fake.command, "fake 1.0.0"), { check: checkFromInstallation, args: ["update"] });
  assert.deepEqual(result, {
    kind: "current",
    version: "1.1.0",
    check: { kind: "ok", installed: "1.1.0", latest: "1.1.0", updateAvailable: false, source: "fixture" },
  });
  assert.equal(fake.read().updateArgs, undefined);
});

test("an unavailable check still lets the updater run and speak for itself", async () => {
  const fake = fakeRuntime("unchecked", { version: "1.0.0", target: "1.1.0", mode: "upgrade" });
  const result = await upgradeExecutable(
    executable(fake.command, "fake 1.0.0"),
    { check: fixedCheck({ kind: "unavailable", reason: "lookup_failed" }), args: ["update"] },
  );
  assert.equal(result.kind, "upgraded");
});

test("a bundled installation has no upgrade", async () => {
  const result = await upgradeExecutable({ kind: "available", via: "bundled" }, { check: fixedCheck(available), args: [] });
  assert.equal(result.kind === "unsupported" ? result.reason : result.kind, "unsupported_installation");
});

test("kimi before 0.43.0 cannot upgrade without a terminal", async () => {
  const result = await kimiUpgrade(executable(path.join(dir, "kimi"), "0.38.0"));
  assert.equal(result.kind === "unsupported" ? result.reason : result.kind, "requires_terminal");
});


test("kimi from 0.43.0 runs its updater with -y", async () => {
  const fake = fakeRuntime("kimi-new", { version: "0.43.0", target: "2.1.1", mode: "upgrade" });
  const result = await kimiUpgrader(fixedCheck({ ...available, installed: "0.43.0", latest: "2.1.1" }))(executable(fake.command, "0.43.0"));
  assert.equal(result.kind === "upgraded" ? result.to : result.kind, "2.1.1");
  assert.deepEqual(fake.read().updateArgs, ["-y"]);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(process.platform === "win32")("a timed out updater is stopped with everything it started", async () => {
  const fake = fakeRuntime("hangs", { version: "1.0.0", target: "1.1.0", mode: "hang" });
  const result = await upgradeExecutable(executable(fake.command, "fake 1.0.0"), { check: fixedCheck(available), args: ["update"] }, { timeoutMs: 1000 });
  assert.ok(result.kind === "failed");
  assert.match(result.output, /stopped the updater after 1000 ms/u);
  const worker = fake.read().workerPid;
  assert.equal(typeof worker, "number");
  await expect.poll(() => alive(Number(worker)), { timeout: 5000 }).toBe(false);
});

test("codex's check reads doctor's JSON even when doctor exits 1", async () => {
  const doctor = JSON.stringify({ overallStatus: "fail", checks: { "updates.status": { details: { "latest version": "0.159.3", "latest version status": "newer version is available", "update action": "standalone installer" } } } });
  const command = printingExecutable({ dir, name: "codex-doctor", line: doctor, exitCode: 1 });
  const check = await codexCheckUpdate(executable(command, "codex-cli 0.158.0"));
  assert.equal(check.kind === "ok" && check.updateAvailable, true);
});
