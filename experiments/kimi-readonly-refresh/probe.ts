/* oxlint-disable no-await-in-loop -- Run isolated native controls sequentially to avoid load-dependent timing. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { kimiRuntime } from "../../packages/oar/src/runtimes/kimi/index.js";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { kimiWebEndpoint, kimiWebRequest } from "../../packages/oar/src/runtimes/kimi/web-query.js";
import { kimiExpiredUsageFixture } from "../../sea-trial/vendor/support/kimi-expired-usage.js";

const [command, output] = process.argv.slice(2);
assert.ok(command !== undefined && command !== "" && output !== undefined && output !== "", "usage: probe.ts /absolute/path/to/kimi output.json");
const installation = { kind: "available", via: "executable", command: resolve(command) } as const;
const rows: unknown[] = [];

/** The pre-fix adapter's native query and immediate process cleanup. */
async function unprotectedSkills(env: Record<string, string | null>, cwd: string): Promise<string> {
  const controller = new AbortController(); const timer = setTimeout(() => { controller.abort(); }, 30_000);
  const child = spawnLineProcess(installation.command, ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"], { env: sessionEnvironment(env), cwd, killTree: true, inheritStderr: false });
  try {
    const web = await kimiWebEndpoint(child, controller.signal);
    await kimiWebRequest(web, controller.signal, "/workspaces");
    const registered = await kimiWebRequest(web, controller.signal, "/workspaces", "POST", { root: cwd });
    assert.equal(typeof registered.id, "string");
    const path = `/workspaces/${encodeURIComponent(String(registered.id))}`;
    const catalog = await kimiWebRequest(web, controller.signal, `${path}/skills`);
    await kimiWebRequest(web, controller.signal, path, "DELETE");
    assert.ok(Array.isArray(catalog.skills)); return "ok";
  } finally { clearTimeout(timer); child.kill(); await child.exited; }
}

for (const mode of ["native-skills", "adapter-skills", "adapter-concurrent", "native-skills-lock-disabled", "lock-disabled", "adapter-skills-lock-disabled"]) {
  for (let round = 0; round < 3; round++) {
    // Delay only the synthetic refresh reply after accepting and rotating the
    // submitted generation. This exposes the shutdown interval, not its frequency.
    const fixture = await kimiExpiredUsageFixture("success", 600);
    try {
      await writeFile(join(fixture.home, "server.token"), "synthetic-local-server-token", { mode: 0o600 });
      const env = { ...fixture.env, KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: "1", KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: "1" };
      const usageEnv = { ...env, ...(mode.includes("lock-disabled") ? { KIMI_DISABLE_OAUTH_LOCK: "1" } : {}) };
      let skills: string | null = null; let usage: { kind: string } | null = null;
      if (mode === "adapter-concurrent") {
        const [skillsResult, usageResult] = await Promise.all([kimiRuntime.skills(installation, { env, cwd: fixture.dir, timeoutMs: 30_000 }), kimiRuntime.accountUsage(installation, { env: usageEnv, timeoutMs: 30_000 })]);
        skills = skillsResult.kind; usage = usageResult;
      } else if (mode.startsWith("native-skills")) { skills = await unprotectedSkills({ ...env, KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: "0" }, fixture.dir); }
      else if (mode.startsWith("adapter-skills")) { const result = await kimiRuntime.skills(installation, { env, cwd: fixture.dir, timeoutMs: 30_000 }); skills = result.kind; }
      const beforeUsage = await fixture.observe();
      usage ??= await kimiRuntime.accountUsage(installation, { env: usageEnv, timeoutMs: 30_000 });
      rows.push({ mode, round, skills, usage, beforeUsage, afterUsage: await fixture.observe() });
      await writeFile(output, JSON.stringify({ refreshReplyDelayMs: 600, rows }, null, 2));
    } finally { await fixture.dispose(); }
  }
}
