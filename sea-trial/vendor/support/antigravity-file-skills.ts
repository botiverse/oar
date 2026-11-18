/* oxlint-disable max-statements, max-lines-per-function, no-await-in-loop, oxc/no-map-spread -- A sequential native differential control preserves startup and precedence evidence. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillEntry } from "../../../packages/oar/src/contracts/inventory.js";
import { antigravityRuntime } from "../../../packages/oar/src/runtimes/antigravity/index.js";
import { runExecutable } from "../../../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson } from "../../../packages/oar/src/shared/json.js";
import { nativeRows } from "../../../packages/oar/src/shared/inventory.js";
import { antigravitySkillMcpControl } from "./antigravity-skill-mcp.js";
import { startAntigravityAimock } from "../../harness/aimock-acp.js";

async function file(path: string, contents: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
async function skill(path: string, name: string, description: string, flags = ""): Promise<void> {
  await file(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${flags}---\nPRIVATE BODY\n`);
}
function project(value: unknown): SkillEntry[] {
  return nativeRows(value).map(row => {
    assert.equal(typeof row.name, "string"); assert.equal(typeof row.path, "string");
    return { name: String(row.name), path: String(row.path), ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(typeof row.plugin === "string" ? { plugin: row.plugin } : {}), ...(row.builtin === true ? { scope: "builtin" } : {}), disableModelInvocation: row.model_invocable === false };
  });
}

/** Real CLI, synthetic local provider, no model prompt or user configuration. */
export async function compareAntigravityFileSkills(output: string): Promise<void> {
  const installation = await antigravityRuntime.installation();
  assert.equal(installation.kind, "available"); assert.equal(installation.via, "executable");
  assert.ok(installation.version === "1.5.10" || installation.version === "1.5.11", "Select a verified file-reader version");
  const fixture = await startAntigravityAimock(() => {});
  const home = fixture.env.HOME; assert.ok(home !== undefined);
  const cwd = join(home, "repo", "sub"); await mkdir(cwd, { recursive: true });
  const nativeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...fixture.env,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "no-bus")}`, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
  const env: Record<string, string | null> = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...Object.fromEntries(Object.entries(nativeEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
  const observations: unknown[] = [];
  try {
    const cold = await antigravityRuntime.skills(installation, { cwd, env });
    assert.equal(cold.kind, "ok"); assert.equal(cold.partial, true); assert.equal(cold.items.length, 0);
    observations.push({ case: "before-native-startup", result: cold, command: installation.command });
    const git = await runExecutable("git", ["init", dirname(cwd)], { env: nativeEnv }); assert.ok(git.ok);
    for (const stage of ["builtins", "roots", "flags-plugins", "manifests", "global-manifests"] ) {
      if (stage === "roots") {
        const roots = [join(cwd, ".agent"), join(cwd, ".agents"), join(cwd, "_agent"), join(cwd, "_agents"), join(dirname(cwd), ".agents"),
          join(home, ".gemini/antigravity-cli"), join(home, ".gemini/config"), join(home, ".gemini")];
        for (const [index, root] of roots.entries()) {
          await skill(join(root, "skills", `root-${index}`), `root-${index}`, `root ${index}`);
          await skill(join(root, "skills/duplicate"), "duplicate", `priority ${index}`);
        }
      }
      if (stage === "flags-plugins") {
        await skill(join(cwd, ".agents/skills/manual"), "manual", "manual", "disable-model-invocation: true\n");
        await skill(join(cwd, ".agents/skills/hidden"), "hidden", "hidden", "disable-slash-command: true\n");
        await skill(join(cwd, ".agents/skills/invalid-flag"), "invalid-flag", "invalid", 'disable-model-invocation: "true"\n');
        await file(join(cwd, ".agents/skills/folded/SKILL.md"), "---\nname: folded\ndescription: >-\n  first line\n  second line\n---\nBODY\n");
        await file(join(cwd, ".agents/skills/flow/SKILL.md"), "---\n{name: yaml-flow, disable-model-invocation: y}\n---\nBODY\n");
        await file(join(cwd, ".agents/skills/non-map/SKILL.md"), "---\nnot a mapping\n---\nBODY\n");
        await file(join(cwd, ".agents/skills/scalar/SKILL.md"), "---\nname: 1.0\ndescription: 2026-11-18\n---\nBODY\n");
        await file(join(cwd, ".agents/skills/fallback/SKILL.md"), "---\ndescription: fallback name\n---\nBODY\n");
        await file(join(cwd, ".agents/skills/malformed/SKILL.md"), "---\nname: [invalid\n---\nBODY\n");
        await skill(join(cwd, ".agents/skills/nested/ignored"), "nested-ignored", "too deep");
        for (const [index, root] of [join(home, ".gemini/config"), join(home, ".gemini/antigravity-cli"), join(cwd, ".agents")].entries()) {
          const plugin = join(root, "plugins", `plugin-${index}`);
          await file(join(plugin, "plugin.json"), JSON.stringify({ name: `Display ${index}`, version: "1.0.0" }));
          await skill(join(plugin, "skills/child"), "child", `plugin ${index}`);
        }
        const copy = join(cwd, ".agents/plugins/copied");
        await file(join(copy, "plugin.json"), JSON.stringify({ name: "Copied" }));
        await file(join(copy, "skills/child/SKILL.md"), await readFile(join(home, ".gemini/config/plugins/plugin-0/skills/child/SKILL.md"), "utf8"));
        const malformedPlugin = join(cwd, ".agents/plugins/malformed");
        await file(join(malformedPlugin, "plugin.json"), "{");
        await skill(join(malformedPlugin, "skills/child"), "child", "malformed plugin omitted");
        const disabled = join(cwd, ".agents/plugins/disabled");
        await file(join(disabled, "plugin.json"), JSON.stringify({ name: "Disabled", disabled: true }));
        await skill(join(disabled, "skills/child"), "child", "disabled");
      }
      if (stage === "manifests") {
        await skill(join(cwd, "extra/included"), "manifest", "declared");
        await skill(join(cwd, "extra/excluded"), "excluded", "excluded");
        await skill(join(cwd, "extra/deep/child"), "deep", "explicit nested");
        await file(join(cwd, ".agents/skills.json"), JSON.stringify({ entries: [{ path: "extra", exclude: ["excluded"] }, { path: "extra", include_only: ["deep/child"] }], inherits: [{ path: "inherited.json" }] }));
        await skill(join(cwd, "inherited/child"), "inherited", "inherited");
        await file(join(cwd, "inherited.json"), JSON.stringify({ entries: [{ path: "inherited" }] }));
      }
      if (stage === "global-manifests") {
        const globalBase = join(home, ".gemini/config");
        await skill(join(globalBase, "declared/child"), "global-declared", "config-relative");
        await skill(join(globalBase, "declared/builtin-shadow"), "run-workflow", "native declared override");
        await file(join(globalBase, "skills.json"), JSON.stringify({ entries: [{ path: "declared" }] }));
        await skill(join(home, "outside/child"), "outside-project", "ignored workspace escape");
        await file(join(cwd, ".agent/skills.json"), JSON.stringify({ entries: [{ path: join(home, "outside") }] }));
      }
      const native = await runExecutable(installation.command, ["--output-format", "json", "--print=/skills"], { cwd, env: nativeEnv, timeoutMs: 15_000 });
      assert.ok(native.ok, native.stderr);
      const payload = asRecord(parseJson(native.stdout)); assert.ok(payload); const command = asRecord(payload.command); assert.ok(command);
      assert.equal(payload.conversation_id, ""); assert.equal(payload.num_turns, 0); assert.equal(command.name, "skills");
      const expected = project(asRecord(command.data)?.skills);
      observations.push({ case: stage, nativeRaw: native, config: await readFile(join(home, ".gemini/config/config.json"), "utf8").catch(() => null) });
      const timings: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        const started = performance.now(); const result: Awaited<ReturnType<typeof antigravityRuntime.skills>> = await antigravityRuntime.skills(installation, { cwd, env }); timings.push(performance.now() - started);
        observations.push({ case: stage, round, result, native: expected });
        assert.equal(result.kind, "ok"); assert.equal(result.view, "discovered"); assert.equal(result.partial, false); assert.deepEqual(result.items, expected);
      }
      observations.push({ case: stage, timingsMs: timings });
    }
    observations.push(...await antigravitySkillMcpControl(installation, home, cwd, nativeEnv, env));
    // The verified path still works signed out, and touches no files.
    const settings = join(home, ".gemini/antigravity-cli/settings.json");
    await file(settings, "{}\n");
    const before = await readdir(home, { recursive: true }); const settingsBefore = await readFile(settings, "utf8");
    const unsigned = await antigravityRuntime.skills(installation, { cwd, env: { ...env, GEMINI_API_KEY: null } }); assert.equal(unsigned.kind, "ok");
    assert.deepEqual(await readdir(home, { recursive: true }), before); assert.equal(await readFile(settings, "utf8"), settingsBefore);
    observations.push({ case: "signed-out-local", result: unsigned });
    assert.equal(fixture.raw.length, 0);
  } finally {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ version: installation.version, observations, modelRequests: fixture.raw.length }, null, 2).replaceAll(home, "<home>").replaceAll(JSON.stringify(home).slice(1, -1), "<home>"));
    await fixture.stop();
  }
}
