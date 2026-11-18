/* oxlint-disable max-statements -- One isolated native fallback control retains startup and signed-out observations. */
import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import { startAntigravityAimock } from "../harness/aimock-acp.js";

test.skipIf(process.env.OAR_TEST !== "antigravity-file-skills" || process.platform !== "win32")("Windows keeps the pinned native skill reader and authentication guard", { timeout: 60_000 }, async () => {
  const installation = await antigravityRuntime.installation();
  assert.equal(installation.kind, "available"); assert.equal(installation.via, "executable"); assert.equal(installation.version, "1.5.11");
  const fixture = await startAntigravityAimock(() => {});
  const home = fixture.env.HOME; assert.ok(home !== undefined);
  const cwd = join(home, "project"); await mkdir(cwd, { recursive: true });
  const nativeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...fixture.env,
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
  const env: Record<string, string | null> = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])),
    ...Object.fromEntries(Object.entries(nativeEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
  const observations: unknown[] = [];
  try {
    const path = join(cwd, ".agents/skills/manual/SKILL.md"); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "---\nname: oar-native-windows\ndescription: Native fallback metadata\ndisable-model-invocation: true\n---\nPRIVATE BODY\n");
    const builtins = join(home, ".gemini/antigravity-cli/builtin/skills");
    assert.deepEqual(await readdir(builtins).catch(() => []), []);
    const result = await antigravityRuntime.skills(installation, { cwd, env });
    observations.push({ case: "native-fallback", result });
    assert.equal(result.kind, "ok"); assert.equal(result.view, "discovered"); assert.equal(result.partial, false);
    assert.deepEqual(result.items.find(item => item.name === "oar-native-windows"), { name: "oar-native-windows", description: "Native fallback metadata", path, disableModelInvocation: true });
    assert.ok(result.items.some(item => item.scope === "builtin"));
    const initialized = await readdir(builtins);
    assert.ok(initialized.length > 0, "Native startup initializes builtins; the file reader must not run on Windows");
    assert.ok(!JSON.stringify(result).includes("PRIVATE BODY"));
    await rm(join(home, ".gemini"), { recursive: true, force: true });
    const unsigned = await antigravityRuntime.skills(installation, { cwd, env: { ...env, GEMINI_API_KEY: null } });
    observations.push({ case: "signed-out-native", result: unsigned });
    assert.equal(unsigned.kind, "unavailable"); assert.equal(unsigned.code, "not_authenticated");
    assert.equal(fixture.raw.length, 0);
  } finally {
    const output = resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "antigravity-file-skills", "windows-native.json");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ version: installation.version, platform: process.platform, observations, modelRequests: fixture.raw.length }, null, 2)
      .replaceAll(home, "<home>").replaceAll(JSON.stringify(home).slice(1, -1), "<home>"));
    await fixture.stop();
  }
});
