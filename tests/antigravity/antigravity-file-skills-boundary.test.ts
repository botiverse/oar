import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readAntigravityFileSkills } from "../../packages/oar/src/runtimes/antigravity/skill-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); }));
});

async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function writeSkill(dir: string, name: string, description = name): Promise<void> {
  await writeText(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBODY\n`);
}

async function createSandbox(gitRepo = true): Promise<{ readonly base: string; readonly home: string; readonly repo: string; readonly cwd: string; readonly outside: string }> {
  const base = await mkdtemp(join(tmpdir(), "oar-agy-boundary-"));
  roots.push(base);
  const paths = { base, home: join(base, "home"), repo: join(base, "repo"), cwd: join(base, "repo", "sub"), outside: join(base, "outside") };
  await Promise.all([mkdir(paths.home, { recursive: true }), mkdir(paths.cwd, { recursive: true }), mkdir(paths.outside, { recursive: true })]);
  if (gitRepo) { await writeText(join(paths.repo, ".git", "HEAD"), "ref: refs/heads/main\n"); }
  return paths;
}

test("workspace skill directory symlink escaping the repository root is omitted", async () => {
  const { home, cwd, outside } = await createSandbox();
  await writeSkill(join(outside, "s1"), "ws-dir-link-outside");
  await mkdir(join(cwd, ".agents/skills"), { recursive: true });
  await symlink(join(outside, "s1"), join(cwd, ".agents/skills/link1"), "junction");

  const result = await readAntigravityFileSkills(home, cwd, new AbortController().signal);
  expect(result.items).toEqual([]);
});

test("workspace SKILL.md file symlink escaping the repository root is omitted", async () => {
  const { home, cwd, outside } = await createSandbox();
  await writeSkill(join(outside, "s2"), "ws-file-link-outside");
  await mkdir(join(cwd, ".agents/skills/realdir"), { recursive: true });
  await symlink(join(outside, "s2/SKILL.md"), join(cwd, ".agents/skills/realdir/SKILL.md"));

  const result = await readAntigravityFileSkills(home, cwd, new AbortController().signal);
  expect(result.items).toEqual([]);
});

test("workspace plugin symlinks escaping the repository root are omitted", async () => {
  const { home, cwd, outside } = await createSandbox();
  await writeText(join(outside, "p1/plugin.json"), JSON.stringify({ name: "Outside Plugin", version: "1.0.0" }));
  await writeSkill(join(outside, "p1/skills/ps1"), "ws-plugin-link-outside");
  await mkdir(join(cwd, ".agents/plugins"), { recursive: true });
  await symlink(join(outside, "p1"), join(cwd, ".agents/plugins/plink1"), "junction");

  await writeText(join(cwd, ".agents/plugins/hybrid/plugin.json"), JSON.stringify({ name: "Hybrid Plugin", version: "1.0.0" }));
  await mkdir(join(cwd, ".agents/plugins/hybrid/skills"), { recursive: true });
  await symlink(join(outside, "p1/skills/ps1"), join(cwd, ".agents/plugins/hybrid/skills/escaped"), "junction");

  const result = await readAntigravityFileSkills(home, cwd, new AbortController().signal);
  expect(result.items).toEqual([]);
});

test("workspace manifest include_only relative traversal escaping the repository root is omitted", async () => {
  const { home, cwd, outside } = await createSandbox();
  await writeSkill(join(outside, "s4"), "escaped-include-only");
  await writeText(join(cwd, ".agents/skills.json"), JSON.stringify({
    entries: [{ path: ".", include_only: ["../../../outside/s4"] }],
  }));

  const result = await readAntigravityFileSkills(home, cwd, new AbortController().signal);
  expect(result.items).toEqual([]);
});

test("workspace manifest directory containing a child symlink outside the repository root omits that child", async () => {
  const { home, repo, cwd, outside } = await createSandbox();
  await writeSkill(join(outside, "s3"), "ws-manifest-child-link-outside");
  await writeSkill(join(repo, "manifest-bag/kept"), "ws-manifest-child-inside");
  await symlink(join(outside, "s3"), join(repo, "manifest-bag/mlink"), "junction");
  await writeText(join(cwd, ".agents/skills.json"), JSON.stringify({
    entries: [{ path: "manifest-bag" }],
  }));

  const result = await readAntigravityFileSkills(home, cwd, new AbortController().signal);
  expect(result.items.map((item) => item.name)).toEqual(["ws-manifest-child-inside"]);
});

test("non-git working directory bounds workspace skill discovery to realpath(cwd)", async () => {
  const { home, repo, cwd } = await createSandbox(false);
  await writeSkill(join(repo, "sibling"), "nongit-parent-link");
  await mkdir(join(cwd, ".agents/skills"), { recursive: true });
  await symlink(join(repo, "sibling"), join(cwd, ".agents/skills/p-link"), "junction");

  const result = await readAntigravityFileSkills(home, cwd, new AbortController().signal);
  expect(result.items).toEqual([]);
});

test("global ~/.gemini skill symlinks outside the workspace and intra-repo workspace symlinks remain discovered", async () => {
  const { home, repo, cwd, outside } = await createSandbox();
  await writeSkill(join(outside, "g1"), "global-link-outside");
  await mkdir(join(home, ".gemini/skills"), { recursive: true });
  await symlink(join(outside, "g1"), join(home, ".gemini/skills/g-link"), "junction");

  await writeSkill(join(repo, "shared-skills/in1"), "ws-link-inside-repo");
  await mkdir(join(cwd, ".agents/skills"), { recursive: true });
  await symlink(join(repo, "shared-skills/in1"), join(cwd, ".agents/skills/in-link"), "junction");

  const result = await readAntigravityFileSkills(home, cwd, new AbortController().signal);
  expect(result.items.map((item) => item.name)).toEqual(["global-link-outside", "ws-link-inside-repo"]);
  expect(result.items.find((item) => item.name === "ws-link-inside-repo")?.path).toContain(join(".agents", "skills", "in-link", "SKILL.md"));
});
