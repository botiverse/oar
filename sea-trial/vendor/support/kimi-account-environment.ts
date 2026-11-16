/** The real CLI inherits an account home for both account usage and account status. */
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
      const reports = parseJson(await invoke(["account", "usage", "kimi", "--json"]));
      assert.ok(Array.isArray(reports) && reports.length === 1);
      const usage = asRecord(asRecord(reports[0])?.accountUsage);
      assert.equal(usage?.kind, "available", JSON.stringify(usage));
      assert.equal(usage.displayName, `Fixture ${account}`);
      assert.equal(usage.rateLimited, account === "A");
      const statuses = parseJson(await invoke(["account", "status", "kimi", "--json"]));
      assert.ok(Array.isArray(statuses) && statuses.length === 1);
      assert.equal(asRecord(asRecord(statuses[0])?.status)?.kind, "logged_in", JSON.stringify(statuses));
      const table = await invoke(["account", "usage", "kimi"]);
      assert.ok(table.startsWith("kimi\t") && table.includes(`Fixture ${account}`), table);
      assert.equal(table.includes("rate limited now"), account === "A", table);
      observed.push({ account, usage, tableRateLimited: account === "A" });
    }
    assert.equal(fixture.requests.filter(entry => entry.path.startsWith("/api/oauth")).length, loginRequests);
    assert.ok(fixture.requests.every(entry => ["/api/oauth/device_authorization", "/api/oauth/token", "/models", "/me", "/usages"].includes(entry.path)));
    return { version: version.stdout.trim(), platform: process.platform, cli: built ? "built" : "source", observed, noLoginDuringReads: true, requests: fixture.requests };
  } finally { await fixture.dispose(); }
}
