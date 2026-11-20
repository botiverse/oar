import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoginResult } from "../../packages/oar/src/contracts/login.js";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { kimiLoginFixture } from "../../sea-trial/vendor/support/kimi-login.js";
import { captureProcess } from "../../tests/fixtures/process-tree.js";
import { recordedInteraction } from "../../tests/fixtures/login-interaction.js";

assert.equal(process.platform, "linux", "This probe uses a Linux shell browser helper");
const [command] = process.argv.slice(2);
assert.ok(command !== undefined && path.isAbsolute(command), "Pass the absolute path to Kimi 2.4.1");
interface Observation { readonly delayMs: number; readonly login: string; readonly callbackRecorded: boolean; readonly browserRunning: boolean; readonly observerRunning: boolean; readonly observerExitCode: number | null }
async function probe(delayMs: number, executable: string): Promise<Observation> {
  const fixture = await kimiLoginFixture();
  try {
    await writeFile(fixture.controlBrowser, `#!/bin/sh\nsleep ${String(delayMs / 1000)}\nexit 0\n`, { mode: 0o700 });
    const result: LoginResult = await kimiRuntime.login({ kind: "available", via: "executable", command: executable, version: "2.4.1" }, recordedInteraction([]), {
      env: fixture.env, openBrowser: true, region: "global", timeoutMs: 30_000,
    });
    assert.deepEqual(result, { kind: "logged_in" });
    const executions = await fixture.executions();
    const calls = executions.filter((entry) => entry.file === fixture.controlBrowser);
    const launches = calls.filter((entry) => entry.child !== undefined);
    assert.equal(launches.length, 1);
    const [launch] = launches; assert.ok(launch?.child !== undefined);
    const browserRunning = fixture.processRunning(launch.child);
    const observerRunning = fixture.processRunning(launch.observer);
    const exits = await fixture.observerExits();
    const observerExit = exits.find((entry) => entry.observer.pid === launch.observer.pid && entry.observer.start === launch.observer.start);
    assert.equal(fixture.processRunning(captureProcess(process.pid)), true, "The surviving observer is a live-process control");
    assert.equal(browserRunning, false);
    assert.equal(observerRunning, false);
    assert.equal(observerExit?.code, 0);
    return { delayMs, login: result.kind, callbackRecorded: calls.some((entry) => entry.code !== undefined), browserRunning, observerRunning, observerExitCode: observerExit.code };
  } finally { await fixture.dispose(); }
}
// Keep the timing controls sequential so they do not compete for native startup.
const rows = [await probe(0, command), await probe(100, command), await probe(1000, command)];
console.log(JSON.stringify({ platform: process.platform, kimi: "2.4.1", rows }, null, 2));
