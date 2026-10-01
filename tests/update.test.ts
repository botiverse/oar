import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import type { ExecutableInstallation } from "../packages/oar/src/contracts/installation.js";
import type { UpdateCheck, UpdateChecker } from "../packages/oar/src/contracts/update.js";
import { kimiUpgrade } from "../packages/oar/src/runtimes/kimi/update.js";
import { upgradeExecutable } from "../packages/oar/src/shared/update.js";

const fakeUpdater = path.join(import.meta.dirname, "fixtures", "fake-updater.mjs");
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "oar-update-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function executable(command: string, version?: string): ExecutableInstallation {
  return version === undefined
    ? { kind: "available", via: "executable", command }
    : { kind: "available", via: "executable", command, version };
}

interface FakeState {
  readonly version: string;
  readonly target: string;
  readonly mode: "upgrade" | "noop" | "fail" | "prompt";
}

/** A fake runtime CLI and the state file that drives it. */
function fakeRuntime(name: string, state: FakeState): { readonly command: string; readonly read: () => Record<string, unknown> } {
  const stateFile = path.join(dir, `${name}.json`);
  writeFileSync(stateFile, JSON.stringify(state));
  const command = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(command, process.platform === "win32"
    ? `@"${process.execPath}" "${fakeUpdater}" "${stateFile}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeUpdater}" "${stateFile}" "$@"\n`);
  chmodSync(command, 0o755);
  const read = (): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.ok(typeof parsed === "object" && parsed !== null);
    return Object.fromEntries(Object.entries(parsed));
  };
  return { command, read };
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

