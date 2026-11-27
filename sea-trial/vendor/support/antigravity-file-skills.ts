/* oxlint-disable max-statements, max-lines-per-function, no-await-in-loop, oxc/no-map-spread -- A sequential native differential control preserves startup and precedence evidence. */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillEntry } from "../../../packages/oar/src/contracts/inventory.js";
import { antigravityRuntime } from "../../../packages/oar/src/runtimes/antigravity/index.js";
import { runExecutable } from "../../../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson } from "../../../packages/oar/src/shared/json.js";
import { nativeRows } from "../../../packages/oar/src/shared/inventory.js";
import { antigravitySkillMcpControl } from "./antigravity-skill-mcp.js";
import { startAntigravityAimock } from "../../harness/aimock-acp.js";

function semverAtLeast(version: string | undefined, minMajor: number, minMinor: number, minPatch: number): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version ?? "");
  if (match === null) { return false; }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major !== minMajor ? major > minMajor : (minor !== minMinor ? minor > minMinor : patch >= minPatch);
}

async function file(path: string, contents: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
async function skill(path: string, name: string, description: string, flags = ""): Promise<void> {
  await file(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${flags}---\nPRIVATE BODY\n`);
}
function project(value: unknown): SkillEntry[] {
  return nativeRows(value).map(row => {
    assert.equal(typeof row.name, "string"); assert.equal(typeof row.path, "string");
    return { name: String(row.name), userInvocable: true, path: String(row.path), ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(typeof row.plugin === "string" ? { plugin: row.plugin } : {}), ...(row.builtin === true ? { scope: "builtin" } : {}), disableModelInvocation: row.model_invocable === false };
  });
}

/** Real CLI, synthetic local provider, no model prompt or user configuration. */
export async function compareAntigravityFileSkills(output: string): Promise<void> {
  const installation = await antigravityRuntime.installation();
  assert.equal(installation.kind, "available"); assert.equal(installation.via, "executable");
  const installedVersion = installation.version;
  assert.ok(installedVersion !== undefined && semverAtLeast(installedVersion, 1, 5, 10), "Select a verified file-reader version");
  const fixture = await startAntigravityAimock(() => {});
  const home = fixture.env.HOME; assert.ok(home !== undefined);
  const cwd = join(home, "repo", "sub"); await mkdir(cwd, { recursive: true });
  const nativeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...fixture.env,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "no-bus")}`, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
  const env: Record<string, string | null> = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...Object.fromEntries(Object.entries(nativeEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
  const swarmBuiltin = join(home, ".gemini/antigravity-cli/builtin/skills/native_swarm/SKILL.md");
  const observations: unknown[] = [];
  let queryCwd = cwd;
  try {
    const cold = await antigravityRuntime.skills(installation, { cwd, env });
    assert.equal(cold.kind, "ok"); assert.equal(cold.partial, true); assert.equal(cold.items.length, 0);
    observations.push({ case: "before-native-startup", result: cold, command: installation.command });
    const git = await runExecutable("git", ["init", dirname(cwd)], { env: nativeEnv }); assert.ok(git.ok);
    for (const stage of ["builtins", "roots", "flags-plugins", "manifests", "global-manifests", "symlinks"] ) {
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
        await file(join(cwd, ".agents/skills/padded-fence/SKILL.md"), "---   \nname: padded-fence\ndescription: padded delimiters\n   ---  \nBODY\n");
        await file(join(cwd, ".agents/skills/empty-padded/SKILL.md"), "--- \n --- \nBODY\n");
        await file(join(cwd, ".agents/skills/four-dash-open/SKILL.md"), "----\nname: four-dash-open\n---\nBODY\n");
        await file(join(cwd, ".agents/skills/open-foo/SKILL.md"), "--- foo\nname: open-foo\n---\nBODY\n");
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
        if (semverAtLeast(installedVersion, 1, 5, 16)) {
          await skill(join(home, ".agents/skills/from-agents"), "from-agents", "global agents root");
          await skill(join(home, ".agent/skills/ignored-dot-agent"), "ignored-dot-agent", "ignored singular global root");
          await file(join(home, ".agents/plugins/ignored-p/plugin.json"), JSON.stringify({ name: "Ignored Agents Plugin", version: "1.0.0" }));
          await skill(join(home, ".agents/plugins/ignored-p/skills/child"), "ignored-agents-plugin", "ignored global agents plugin");
          await skill(join(home, ".agents/manifest-target/child"), "ignored-agents-manifest", "ignored global agents manifest");
          await file(join(home, ".agents/skills.json"), JSON.stringify({ entries: [{ path: "manifest-target" }] }));
          await skill(join(home, ".gemini/skills/global-agents-dup"), "global-agents-dup", "from-gemini-skills");
          await skill(join(home, ".agents/skills/global-agents-dup"), "global-agents-dup", "from-agents-skills");
          await skill(join(home, ".gemini/skills/hidden-agents-dup"), "hidden-agents-dup", "hidden in gemini", "disable-slash-command: true\n");
          await skill(join(home, ".agents/skills/hidden-agents-dup"), "hidden-agents-dup", "visible in agents");
          await skill(join(home, ".agents/skills/global-declared"), "global-declared", "loses to global manifest");
          await skill(join(home, ".agents/skills/automation"), "automation", "agents overrides builtin");
        }
      }
      if (stage === "symlinks") {
        const repo = dirname(cwd); const homeAlias = join(home, "home-alias");
        await symlink(home, homeAlias, "junction");
        queryCwd = join(home, "cwd-alias"); await symlink(cwd, queryCwd, "junction");
        await skill(join(repo, "direct/child"), "linked-direct", "linked skill directory");
        await symlink(join(repo, "direct/child"), join(cwd, ".agents/skills/link"), "junction");
        await skill(join(home, "global-link-target/g1"), "global-link-outside", "global link allowed");
        await symlink(join(home, "global-link-target/g1"), join(home, ".gemini/skills/g-link"), "junction");
        if (semverAtLeast(installedVersion, 1, 5, 16)) {
          await skill(join(home, "global-link-target/g2"), "global-agents-link-outside", "global agents link allowed");
          await symlink(join(home, "global-link-target/g2"), join(home, ".agents/skills/g-agents-link"), "junction");
        }
        await skill(join(home, "ws-escape/s1"), "ws-dir-link-outside", "workspace dir link outside");
        await symlink(join(home, "ws-escape/s1"), join(cwd, ".agents/skills/out-dir-link"), "junction");
        await skill(join(home, "ws-escape/s2"), "ws-file-link-outside", "workspace SKILL.md link outside");
        await mkdir(join(cwd, ".agents/skills/out-file-link"), { recursive: true });
        await symlink(join(home, "ws-escape/s2/SKILL.md"), join(cwd, ".agents/skills/out-file-link/SKILL.md"));
        await file(join(home, "ws-escape/p1/plugin.json"), JSON.stringify({ name: "Escaped Plugin", version: "1.0.0" }));
        await skill(join(home, "ws-escape/p1/skills/ps1"), "ws-plugin-link-outside", "workspace plugin link outside");
        await symlink(join(home, "ws-escape/p1"), join(cwd, ".agents/plugins/out-plugin-link"), "junction");
        await skill(join(home, "ws-escape/s3"), "ws-manifest-child-link-outside", "manifest child link outside");
        await mkdir(join(repo, "manifest-bag"), { recursive: true });
        await symlink(join(home, "ws-escape/s3"), join(repo, "manifest-bag/mlink"), "junction");
        await skill(join(home, "ws-escape/s4"), "escaped-include-only", "manifest include_only traversal outside");
        await skill(join(repo, "alias-extra/child"), "absolute-alias", "declared alias retained");
        await skill(join(home, "outside-link/child"), "outbound-link", "outside target omitted");
        await skill(join(repo, "inside-link/child"), "inbound-link", "inside target allowed");
        await symlink(join(home, "outside-link"), join(repo, "outbound"), "junction");
        await symlink(join(repo, "inside-link"), join(home, "inbound"), "junction");
        await file(join(cwd, ".agent/skills.json"), JSON.stringify({ entries: [
          { path: join(homeAlias, "repo/alias-extra") }, { path: join(repo, "outbound") }, { path: join(home, "inbound") },
          { path: join(repo, "manifest-bag") }, { path: ".", include_only: ["../../../ws-escape/s4"] },
        ] }));
      }
      const native = await runExecutable(installation.command, ["--output-format", "json", "--print=/skills"], { cwd: queryCwd, env: nativeEnv, timeoutMs: 15_000 });
      assert.ok(native.ok, native.stderr);
      const payload = asRecord(parseJson(native.stdout)); assert.ok(payload); const command = asRecord(payload.command); assert.ok(command);
      assert.equal(payload.conversation_id, ""); assert.equal(payload.num_turns, 0); assert.equal(command.name, "skills");
      observations.push({ case: stage, nativeRaw: native, config: await readFile(join(home, ".gemini/config/config.json"), "utf8").catch(() => null) });
      const expected = project(asRecord(command.data)?.skills);
      const swarm = expected.find(item => item.scope === "builtin" && item.path === swarmBuiltin);
      if (semverAtLeast(installedVersion, 1, 5, 14) && swarm !== undefined) {
        assert.equal(swarm.disableModelInvocation, true, "Native marks the mounted swarm builtin as user-invocable only");
      }
      if (stage === "flags-plugins") {
        assert.ok(!expected.some(item => item.name === "hidden"), "Native omits the slash-command-disabled fixture");
        assert.ok(expected.some(item => item.name === "manual" && item.disableModelInvocation === true), "Model-hidden skills remain directly invocable");
      }
      const timings: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        const started = performance.now(); const result: Awaited<ReturnType<typeof antigravityRuntime.skills>> = await antigravityRuntime.skills(installation, { cwd: queryCwd, env }); timings.push(performance.now() - started);
        observations.push({ case: stage, round, result, native: expected });
        assert.equal(result.kind, "ok"); assert.equal(result.view, "discovered"); assert.equal(result.partial, true);
        // Only the unverified builtin mount may be absent; local skills named swarm still compare.
        const verified: readonly SkillEntry[] = expected.filter(item => !(item.scope === "builtin" && item.path === swarmBuiltin));
        assert.deepEqual(result.items, verified);
      }
      observations.push({ case: stage, timingsMs: timings });
    }
    await antigravitySkillMcpControl(installation, home, cwd, nativeEnv, env, observations);
    // Non-git working directories bound workspace discovery at realpath(cwd).
    const nonGitCwd = join(home, "nongit", "work");
    await mkdir(join(nonGitCwd, ".agents/skills"), { recursive: true });
    await skill(join(home, "nongit/sibling/s6"), "nongit-parent-link", "non-git sibling escape");
    await symlink(join(home, "nongit/sibling/s6"), join(nonGitCwd, ".agents/skills/p-link"), "junction");
    const nonGitNative = await runExecutable(installation.command, ["--output-format", "json", "--print=/skills"], { cwd: nonGitCwd, env: nativeEnv, timeoutMs: 15_000 });
    assert.ok(nonGitNative.ok, nonGitNative.stderr);
    const nonGitCommand = asRecord(asRecord(parseJson(nonGitNative.stdout))?.command);
    const nonGitExpected = project(asRecord(nonGitCommand?.data)?.skills);
    assert.ok(!nonGitExpected.some(item => item.name === "nongit-parent-link"));
    const nonGitResult = await antigravityRuntime.skills(installation, { cwd: nonGitCwd, env });
    assert.equal(nonGitResult.kind, "ok");
    const nonGitVerified = nonGitExpected.filter(item => !(item.scope === "builtin" && item.path === swarmBuiltin));
    assert.deepEqual(nonGitResult.items, nonGitVerified);
    observations.push({ case: "non-git-sibling-escape", result: nonGitResult, native: nonGitExpected });
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
