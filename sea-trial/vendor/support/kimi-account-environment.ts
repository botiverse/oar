/** The real CLI inherits an account home for both usage and orientation. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kimiRuntime } from "../../../packages/oar/src/runtimes/kimi/index.js";
import { runExecutable } from "../../../packages/oar/src/shared/executable/index.js";
import { sessionEnvironment } from "../../../packages/oar/src/shared/environment.js";
import { asRecord, parseJson } from "../../../packages/oar/src/shared/json.js";
import { recordedInteraction } from "../../../tests/fixtures/login-interaction.js";
import { kimiLoginFixture } from "./kimi-login.js";

export async function probeKimiAccountEnvironment(command: string, built = false): Promise<unknown> {
  const fixture = await kimiLoginFixture("account-usage");
  const homeB = path.join(fixture.dir, "home-b");
  const hostHome = path.join(fixture.dir, "host-home");
  const installation = { kind: "available" as const, via: "executable" as const, command };
  const observed: unknown[] = [];
  try {
    await mkdir(homeB); await mkdir(hostHome);
    const common = { ...fixture.env, HOME: hostHome, USERPROFILE: hostHome };
    for (const home of [fixture.home, homeB]) {
      assert.deepEqual(await kimiRuntime.login(installation, recordedInteraction([]), {
        env: { ...common, KIMI_CODE_HOME: home }, openBrowser: false, timeoutMs: 30_000,
      }), { kind: "logged_in" });
    }
    const version = await runExecutable(command, ["--version"], { env: sessionEnvironment(common), timeoutMs: 30_000 });
    assert.ok(version.ok);
    const loginRequests = fixture.requests.filter(entry => entry.path.startsWith("/api/oauth")).length;
    const cli = fileURLToPath(new URL(`../../../packages/cli/${built ? "dist/index.js" : "src/index.ts"}`, import.meta.url));
    for (const account of ["A", "B", "A"] as const) {
      const env = sessionEnvironment({ ...common, OAR_KIMI_BIN: command, KIMI_CODE_HOME: account === "A" ? fixture.home : homeB });
      const invoke = async (args: string[]): Promise<string> => {
        const result = await runExecutable(process.execPath, [...(built ? [] : ["--import", import.meta.resolve("tsx")]), cli, ...args], { env, cwd: hostHome, timeoutMs: 60_000 });
        assert.ok(result.ok, `CLI ${args.join(" ")} failed: ${result.stderr}`);
        return result.stdout;
      };
      const reports = parseJson(await invoke(["usage", "kimi"]));
      assert.ok(Array.isArray(reports) && reports.length === 1);
      const usage = asRecord(asRecord(reports[0])?.accountUsage);
      assert.equal(usage?.kind, "available", JSON.stringify(usage));
      assert.equal(usage.displayName, `Fixture ${account}`);
      assert.equal(usage.rateLimited, account === "A");
      const snapshot: unknown = parseJson(await invoke(["orient", "kimi", "--depth", "account", "--json"]));
      assert.ok(asRecord(snapshot)?.depth === "account");
      const runtimes = asRecord(snapshot)?.runtimes;
      assert.ok(Array.isArray(runtimes) && runtimes.length === 1);
      const quota = asRecord(asRecord(runtimes[0])?.accountUsage);
      assert.equal(quota?.kind, "ok");
      assert.deepEqual(quota.value, usage);
      const table = await invoke(["orient", "kimi", "--depth", "account"]);
      assert.ok(table.includes(`\t${account === "A" ? "rate_limited" : "ready"}\t`), table);
      observed.push({ account, usage, tableReadiness: account === "A" ? "rate_limited" : "ready" });
    }
    assert.equal(fixture.requests.filter(entry => entry.path.startsWith("/api/oauth")).length, loginRequests);
    assert.ok(fixture.requests.every(entry => ["/api/oauth/device_authorization", "/api/oauth/token", "/models", "/me", "/usages"].includes(entry.path)));
    return { version: version.stdout.trim(), platform: process.platform, cli: built ? "built" : "source", observed, noLoginDuringReads: true, requests: fixture.requests };
  } finally { await fixture.dispose(); }
}
