/* oxlint-disable max-statements -- Keep the complete native two-reader lifecycle in one fixture scope. */
/* oxlint-disable no-await-in-loop -- Run independent pairs sequentially to avoid cross-pair resource contention. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { kimiWebEndpoint, kimiWebRequest } from "../../packages/oar/src/runtimes/kimi/web-query.js";
import { startKimiWeb } from "../../packages/oar/src/runtimes/kimi/web-startup.js";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { runExecutable, spawnLineProcess, type LineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { kimiExpiredUsageFixture } from "../../sea-trial/vendor/support/kimi-expired-usage.js";
import { schedule } from "./schedule.js";

const command = process.argv[2] ?? ""; const output = process.argv[3] ?? "";
assert.ok(command.length > 0 && output.length > 0, "usage: probe.ts /absolute/kimi output.json");
const installed = await runExecutable(command, ["--version"], { timeoutMs: 10_000 });
assert.equal(installed.ok, true, "native version command must pass");
const version = installed.stdout.trim();
const installation = { kind: "available", via: "executable", command } as const;
type Mode = "unguarded" | "gated" | "adapter" | "usage-and-skills";
const rows: unknown[] = [];

function outcome(result: PromiseSettledResult<string>): unknown {
  return result.status === "fulfilled" ? { status: result.status, kind: result.value }
    : { status: result.status, error: result.reason instanceof Error ? result.reason.name : "unknown" };
}

async function pair(mode: Mode, options: { scheduled: boolean; seeded: boolean; fresh?: boolean }, round: number): Promise<void> {
  const { scheduled, seeded, fresh = false } = options;
  const fixture = await kimiExpiredUsageFixture("success");
  const children: LineProcess[] = [];
  const controller = new AbortController(); const timer = setTimeout(() => { controller.abort(); }, 30_000);
  const origin = Date.now(); const readiness: { reader: number; readyMs: number }[] = [];
  try {
    if (fresh) { await writeFile(fixture.file, JSON.stringify({ access_token: "synthetic-fresh", refresh_token: "synthetic-refresh", expires_at: Date.now() / 1000 + 900, expires_in: 900, token_type: "Bearer" })); }
    if (seeded) { await writeFile(join(fixture.home, "server.token"), "synthetic-local-server-token", { mode: 0o600 }); }
    const timing = join(fixture.dir, "timing.jsonl");
    const timingPreload = join(fixture.dir, "timing.cjs");
    await writeFile(timingPreload, "require('node:fs').appendFileSync(process.env.OAR_KIMI_START_TIMING, JSON.stringify({time:Date.now()})+'\\n');\n");
    const scheduling = join(fixture.dir, "schedule.cjs"); await writeFile(scheduling, schedule);
    const env = { ...fixture.env, OAR_KIMI_START_TIMING: timing, OAR_TEST_TOKEN_SCHEDULE: fixture.dir,
      NODE_OPTIONS: `${fixture.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(timingPreload)}${scheduled ? ` --require ${JSON.stringify(scheduling)}` : ""}` };
    const direct = async (reader: number): Promise<string> => {
      const childEnv = sessionEnvironment(env);
      const started = mode === "gated" ? await startKimiWeb(command, childEnv, controller.signal) : await (async (): ReturnType<typeof startKimiWeb> => {
        const child = spawnLineProcess(command, ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"], { env: childEnv, killTree: true, inheritStderr: false });
        children.push(child);
        const endpoint = kimiWebEndpoint(child, controller.signal);
        // oxlint-disable-next-line promise/prefer-await-to-then -- Observe readiness if spawning fails first.
        void endpoint.catch(() => {});
        await child.spawned; return { child, web: await endpoint };
      })();
      if (mode === "gated") { children.push(started.child); }
      readiness.push({ reader, readyMs: Date.now() - origin });
      const result = await kimiWebRequest(started.web, controller.signal, "/oauth/usage");
      assert.ok(typeof result.kind === "string"); return result.kind;
    };
    const read = async (reader: number): Promise<string> => {
      if (mode === "adapter" || mode === "usage-and-skills") {
        const result = mode === "usage-and-skills" && reader === 1
          ? await kimiRuntime.skills(installation, { env, cwd: fixture.dir, timeoutMs: 30_000 })
          : await kimiRuntime.accountUsage(installation, { env, timeoutMs: 30_000 });
        return result.kind;
      }
      return direct(reader);
    };
    const results = await Promise.allSettled([read(0), read(1)]);
    const observation = await fixture.observe();
    const timingText = await readFile(timing, "utf8");
    const starts = timingText.trim().split("\n").map(line => {
      const value: unknown = JSON.parse(line);
      assert.ok(typeof value === "object" && value !== null && "time" in value && typeof value.time === "number");
      return value.time - origin;
    });
    rows.push({ mode, scheduled, seeded, fresh, round, starts, readiness, outcomes: results.map(result => outcome(result)), observation });
    await writeFile(resolve(output), `${JSON.stringify({ version, rows }, null, 2)}\n`);
    console.log(JSON.stringify({ mode, scheduled, seeded, round, outcomes: results.map(result => outcome(result)) }));
    if (mode !== "unguarded") { assert.ok(results.every(result => result.status === "fulfilled" && ["ok", "available"].includes(result.value)), "every guarded read must succeed"); }
  } finally {
    clearTimeout(timer); controller.abort();
    for (const child of children) { if (!child.stopping()) { child.kill(); } }
    await Promise.all(children.map(async child => { await child.exited; }));
    await fixture.dispose();
  }
}

for (const mode of ["unguarded", "gated"] as const) {
  for (let round = 0; round < 3; round += 1) { await pair(mode, { scheduled: true, seeded: false }, round); }
}
for (const seeded of [false, true]) {
  for (let round = 0; round < 6; round += 1) { await pair("gated", { scheduled: false, seeded }, round); }
}
for (let round = 0; round < 3; round += 1) { await pair("adapter", { scheduled: true, seeded: false }, round); }
for (let round = 0; round < 3; round += 1) { await pair("usage-and-skills", { scheduled: true, seeded: false, fresh: true }, round); }
