/* oxlint-disable no-await-in-loop, max-statements, oxc/no-map-spread -- Each fixture encodes native ordering and duplicate precedence. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import { hasAntigravityFileSkills } from "../../packages/oar/src/runtimes/antigravity/skill-files.js";
import { antigravitySkillMetadata } from "../../packages/oar/src/runtimes/antigravity/skill-metadata.js";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), run: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/antigravity/auth.js", async original => ({ ...await original<object>(), readAntigravityAuthStatus: mocks.auth }));
vi.mock("../../packages/oar/src/shared/executable/index.js", async original => ({ ...await original<object>(), runExecutable: mocks.run }));
const fileTest = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");
const homes: string[] = [];
const installation = { kind: "available", via: "executable", command: "unused-agy", version: "1.5.11" } as const;
async function file(path: string, contents: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
async function skill(dir: string, name: string, extra = ""): Promise<void> { await file(join(dir, "SKILL.md"), `---\nname: ${name}\n${extra}---\nPRIVATE BODY\n`); }
async function fixture(): Promise<{ home: string; cwd: string; env: Record<string, string | null> }> {
  const temporary = await mkdtemp(join(tmpdir(), "oar-agy-files-"));
  const home = await realpath(temporary); homes.push(home);
  const cwd = join(home, "repo/sub"); await mkdir(cwd, { recursive: true });
  await file(join(home, "repo/.git/HEAD"), "ref: refs/heads/main\n");
  return { home, cwd, env: { HOME: home, USERPROFILE: home, GEMINI_HOME: null, GEMINI_API_KEY: null } };
}
afterEach(async () => { await Promise.all(homes.splice(0).map(async home => rm(home, { recursive: true, force: true }))); vi.resetAllMocks(); });

fileTest.each(["1.5.10", "1.5.11"])("%s reads signed-out files without spawning, authentication or builtin initialization", async version => {
  const f = await fixture();
  await skill(join(f.cwd, ".agents/skills/local"), "local", "description: Visible metadata\ndisable-model-invocation: true\n");
  const result = await antigravityRuntime.skills({ ...installation, version }, f);
  assert.equal(result.kind, "ok");
  expect({ view: result.view, partial: result.partial, items: result.items.map(item => ({ ...item, path: item.path?.replace(f.home, "<home>").replaceAll("\\", "/") })) }).toMatchInlineSnapshot(`
    {
      "items": [
        {
          "description": "Visible metadata",
          "disableModelInvocation": true,
          "name": "local",
          "path": "<home>/repo/sub/.agents/skills/local/SKILL.md",
          "userInvocable": true,
        },
      ],
      "partial": true,
      "view": "discovered",
    }
  `);
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

fileTest.each(["1.5.10", "1.5.11"])("%s omits the uncertain swarm builtin and marks even materialized inventories partial", async version => {
  const f = await fixture();
  for (const name of ["agy-customizations", "antigravity_guide", "automation", "migrate-agent-settings", "migrate-workflows", "run-workflow", "native_swarm"]) {
    await skill(join(f.home, ".gemini/antigravity-cli/builtin/skills", name), name === "native_swarm" ? "swarm" : name);
  }
  const result = await antigravityRuntime.skills({ ...installation, version }, f); assert.equal(result.kind, "ok");
  expect(result.partial).toBe(true);
  expect(result.items.map(item => item.name)).toEqual(["agy-customizations", "antigravity_guide", "automation", "migrate-agent-settings", "migrate-workflows", "run-workflow"]);
  await skill(join(f.cwd, ".agents/skills/swarm"), "swarm", "description: Local skill, not the uncertain builtin\n");
  const local = await antigravityRuntime.skills({ ...installation, version }, f); assert.equal(local.kind, "ok");
  expect(local.items.find(item => item.name === "swarm")).toEqual({ name: "swarm", description: "Local skill, not the uncertain builtin", path: join(f.cwd, ".agents/skills/swarm/SKILL.md"), userInvocable: true, disableModelInvocation: false });
  expect(local.partial).toBe(true);
});

fileTest("native root and alias precedence, hidden winners and plugin enable overrides", async () => {
  const f = await fixture();
  for (const [root, description] of [[join(f.home, "repo/.agent"), "repo"], [join(f.cwd, ".agent"), "cwd"], [join(f.home, ".gemini"), "global"]]) {
    assert.ok(root !== undefined); await skill(join(root, "skills/duplicate"), "duplicate", `description: ${description}\n`);
  }
  await skill(join(f.home, "repo/.agent/skills/hidden"), "hidden", "disable-slash-command: true\n");
  await skill(join(f.cwd, ".agents/skills/hidden"), "hidden");
  const plugin = join(f.cwd, ".agents/plugins/identity");
  await file(join(plugin, "plugin.json"), JSON.stringify({ name: "Display name", disabled: true }));
  await skill(join(plugin, "skills/child"), "child");
  await file(join(f.home, ".gemini/config/config.json"), JSON.stringify({ plugins: { identity: { enabled: true } } }));
  const result = await antigravityRuntime.skills(installation, f); assert.equal(result.kind, "ok");
  expect(result.items.every(item => item.userInvocable === true)).toBe(true);
  expect(result.items.map(({ name, description, plugin: owner }) => ({ name, description, plugin: owner }))).toMatchInlineSnapshot(`
    [
      {
        "description": "repo",
        "name": "duplicate",
        "plugin": undefined,
      },
      {
        "description": undefined,
        "name": "identity:child",
        "plugin": "Display name",
      },
    ]
  `);
});

fileTest("native content deduplication precedes plugin namespaces, and malformed plugins are omitted", async () => {
  const f = await fixture();
  for (const name of ["a", "b", "bad"]) {
    const plugin = join(f.cwd, ".agents/plugins", name);
    await file(join(plugin, "plugin.json"), name === "bad" ? "{" : JSON.stringify({ name }));
    await skill(join(plugin, "skills/child"), "child", `description: ${name === "bad" ? "different" : "same"}\n`);
  }
  const result = await antigravityRuntime.skills(installation, f); assert.equal(result.kind, "ok");
  expect(result.items.map(item => item.name)).toEqual(["a:child"]);
});

fileTest("manifest paths preserve workspace bounds, explicit nested selection, global base and inheritance cycles", async () => {
  const f = await fixture();
  await skill(join(f.cwd, "extra/deep/child"), "nested");
  await skill(join(f.home, "outside/child"), "outside");
  await file(join(f.cwd, ".agents/skills.json"), JSON.stringify({ entries: [{ path: "extra", include_only: ["deep/child"] }, { path: join(f.home, "outside") }], inherits: [{ path: ".agents/skills.json" }] }));
  await skill(join(f.home, ".gemini/config/declared/child"), "global");
  await file(join(f.home, ".gemini/config/skills.json"), JSON.stringify({ entries: [{ path: "declared" }] }));
  const result = await antigravityRuntime.skills(installation, f); assert.equal(result.kind, "ok");
  expect(result.items.map(item => item.name)).toEqual(["global", "nested"]);
});

test.each([
  ["name: 1.0\ndescription: 2026-11-18", { name: "1.0", description: "2026-11-18", disableModelInvocation: false }],
  ["name: null\ndescription: null", { name: "folder", disableModelInvocation: false }],
  ["name: ' A/B '\ndescription: |-\n  first\n  second", { name: " A/B ", description: "first\nsecond", disableModelInvocation: false }],
  ["disable-model-invocation: yes", { name: "folder", disableModelInvocation: true }],
  ['disable-model-invocation: "true"', null],
  ["name: [wrong]", null],
  ["not a mapping", null],
  ["{name: flow, disable-model-invocation: y}", { name: "flow", disableModelInvocation: true }],
  ["name: one\nname: two", null],
  ["name: [malformed", null],
])("frontmatter matches native typed fields: %s", async (header, expected) => {
  const f = await fixture(); const path = join(f.cwd, "folder/SKILL.md"); await file(path, `---\n${header}\n---\nPRIVATE BODY\n`);
  const result = await antigravitySkillMetadata(path, AbortSignal.timeout(1000));
  expect(result === null ? null : { ...result.item, path: undefined }).toEqual(expected === null ? null : { ...expected, path: undefined });
});

fileTest.each(["1.5.10", "1.5.11"])("%s preserves native paths through cwd, skill and manifest directory links", async version => {
  const f = await fixture(); const repo = dirname(f.cwd);
  const alias = join(f.home, "cwd-alias"); await symlink(f.cwd, alias, "junction");
  const homeAlias = join(f.home, "home-alias"); await symlink(f.home, homeAlias, "junction");
  await skill(join(repo, ".agents/skills/parent"), "parent");
  await skill(join(repo, "direct/child"), "linked");
  await mkdir(join(f.cwd, ".agents/skills"), { recursive: true });
  await symlink(join(repo, "direct/child"), join(f.cwd, ".agents/skills/link"), "junction");
  await skill(join(repo, "extra/child"), "absolute-alias");
  await skill(join(f.home, "outside/child"), "outside");
  await skill(join(repo, "inside/child"), "inbound");
  await symlink(join(f.home, "outside"), join(repo, "outbound"), "junction");
  await symlink(join(repo, "inside"), join(f.home, "inbound"), "junction");
  await skill(join(f.home, ".gemini/config/skills/global"), "global");
  await file(join(f.cwd, ".agents/skills.json"), JSON.stringify({ entries: [
    { path: join(homeAlias, "repo/extra") }, { path: join(repo, "outbound") }, { path: join(f.home, "inbound") },
  ] }));
  const result = await antigravityRuntime.skills({ ...installation, version }, { cwd: alias, env: { ...f.env, HOME: homeAlias, USERPROFILE: homeAlias } });
  assert.equal(result.kind, "ok");
  expect(result.items.map(({ name, path }) => ({ name, path }))).toEqual([
    { name: "absolute-alias", path: join(homeAlias, "repo/extra/child/SKILL.md") },
    { name: "global", path: join(homeAlias, ".gemini/config/skills/global/SKILL.md") },
    { name: "inbound", path: join(f.home, "inbound/child/SKILL.md") },
    { name: "linked", path: join(f.cwd, ".agents/skills/link/SKILL.md") },
    { name: "parent", path: join(repo, ".agents/skills/parent/SKILL.md") },
  ]);
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

test("verified local reader preserves custom state refusal", async () => {
  const f = await fixture();
  const result = await antigravityRuntime.skills(installation, { ...f, env: { ...f.env, GEMINI_HOME: join(f.home, "other") } });
  expect(result).toMatchObject({ kind: "unsupported", code: "scope_unavailable" });
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
});

// The differential evidence only verifies these two operating systems and versions.
test.each(["linux", "darwin", "win32", "freebsd"] as const)("%s admits only a verified file reader", platform => {
  for (const version of [undefined, "1.5.0", "1.5.10", "1.5.11", "1.5.12"]) {
    expect(hasAntigravityFileSkills(version, platform)).toBe((platform === "linux" || platform === "darwin") && (version === "1.5.10" || version === "1.5.11"));
  }
});
