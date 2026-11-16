import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { opencodeSkillScopes } from "../../packages/oar/src/runtimes/opencode/skill-scope.js";

// oxlint-disable-next-line max-statements -- One disposable root covers real path and classification boundaries.
test.each([1, 2] as const)("OpenCode v%s scopes use real native roots, including shared directories", async major => {
  const root = await mkdtemp(join(tmpdir(), "oar-skill-scope-"));
  const home = join(root, "home"); const repo = join(root, "repo"); const cwd = join(repo, "child");
  const config = join(root, "config");
  const paths = {
    user: join(home, ".claude", "skills", "a", "SKILL.md"),
    project: join(repo, ".agents", "skills", "a", "SKILL.md"),
    config: join(config, "opencode", "skill", "a", "SKILL.md"),
    sibling: join(repo, ".agents", "skills-other", "a", "SKILL.md"),
    unknown: join(root, "elsewhere", ".claude", "skills", "a", "SKILL.md"),
    outside: join(root, "outside", "a", "SKILL.md"),
    linked: join(root, "outside", "skills", "a", "SKILL.md"),
  };
  try {
    await mkdir(cwd, { recursive: true }); await mkdir(join(repo, ".git"));
    await Promise.all(Object.values(paths).map(async path => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, "fixture"); }));
    await symlink(join(root, "outside"), join(repo, ".opencode"), process.platform === "win32" ? "junction" : "dir");
    const classify = await opencodeSkillScopes(cwd, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config }, major);
    await expect(classify(paths.user)).resolves.toEqual({ scope: "user" });
    await expect(classify(paths.project)).resolves.toEqual({ scope: "project" });
    await expect(classify(paths.config)).resolves.toEqual({ scope: "user" });
    await expect(classify(paths.sibling)).resolves.toEqual({});
    await expect(classify(paths.unknown)).resolves.toEqual({});
    await expect(classify(paths.outside)).resolves.toEqual({});
    await expect(classify(paths.linked)).resolves.toEqual({ scope: "project" });
    await expect(classify(join(repo, ".opencode", "skills", "a", "SKILL.md"))).resolves.toEqual({ scope: "project" });
    await expect(classify(join(cwd, ".agents", "skills", "missing"))).resolves.toEqual({});
    await expect(classify("skill://third-party/SKILL.md")).resolves.toEqual({});
    await expect(classify("<built-in>")).resolves.toEqual({ scope: "builtin" });
    await expect(classify("skill://opencode/SKILL.md")).resolves.toEqual(major === 2 ? { scope: "builtin" } : {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
