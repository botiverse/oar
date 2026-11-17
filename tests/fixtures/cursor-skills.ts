/* oxlint-disable max-statements, max-lines-per-function, import/prefer-default-export, no-await-in-loop -- One isolated native fixture, shared by unit and SDK parity cases. */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";

export async function cursorSkillsFixture(git = false) {
  const root = await mkdtemp(join(tmpdir(), "oar-cursor-skills-"));
  const cwd = join(root, "project"); const home = join(root, "home");
  await Promise.all([mkdir(cwd), mkdir(home)]);
  for (const { scope, base } of [{ scope: "user", base: home }, { scope: "project", base: cwd }]) {
    for (const brand of ["cursor", "claude", "codex", "grok", "agents"]) {
      const name = `${scope}-${brand}`;
      await write(base, `.${brand}/skills/${name}`, `name: ${name}\ndescription: fixture ${name}`);
    }
  }
  const cases = {
    ".cursor/skills/folder-name": "name: different-name\ndescription: metadata description",
    ".cursor/skills/invalid-duplicate": "name: [bad",
    ".claude/skills/invalid-duplicate": "description: must not replace native invalid duplicate",
    ".cursor/skills/invalid": "name: [bad",
    ".cursor/skills/missing-description": "name: missing-description",
    ".cursor/skills/always": "description: always\nalwaysApply: true",
    ".cursor/skills/ide-only": "description: ide\nmetadata:\n  surfaces: [ide]",
    ".cursor/skills/long-description": `description: "${"A".repeat(1535)}😀end"`,
    ".cursor/skills/sdk-only": "description: sdk\nmetadata:\n  surfaces: sdk",
    ".cursor/skills/disabled": "disable-model-invocation: true",
    ".cursor/skills/duplicate": "description: cursor duplicate",
    ".claude/skills/duplicate": "description: claude duplicate",
    ".cursor/skills/.hidden": "description: hidden",
    ".cursor/skills/node_modules/dependency": "description: dependency",
    ".codex/skills/imagegen": "description: filtered",
    ".claude/skills/imagegen": "description: not filtered",
    ".cursor/rules/in-rules": "description: rule folder",
    ".cursor/skills-cursor/builtin": "description: excluded managed root",
    "nested-root/.cursor/skills": "description: skill at nested root",
    "nested/.cursor/skills/nested-cursor": "description: nested cursor",
    "nested/.agents/skills/nested-agents": "description: nested agents",
    "ignored/.cursor/skills/ignored": "description: git ignored",
    "node_modules/a/.cursor/skills/dependency": "description: dependency excluded",
    ".hidden/.cursor/skills/hidden-parent": "description: hidden parent",
  };
  for (const [path, metadata] of Object.entries(cases)) { await write(cwd, path, metadata); }
  await write(home, ".cursor/skills-cursor/managed", "description: managed excluded");
  await write(root, "outside", "description: outside roots");
  await write(cwd, `.cursor/skills/${Array.from({ length: 11 }, () => "deep").join("/")}`, "description: beyond direct depth");
  await writeFile(join(cwd, ".gitignore"), "ignored/\n");
  await symlink(join(cwd, ".cursor", "skills", "project-cursor"), join(cwd, ".agents", "skills", "alias"), "junction");
  await symlink(join(root, "outside"), join(cwd, ".agents", "skills", "outside"), "junction");
  if (git) {
    const result = await runExecutable("git", ["init", "-q"], { cwd });
    if (!result.ok) { throw new Error("Fixture git init failed"); }
  }
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata") };
  return { root, cwd, home, env, write };
}

async function write (base: string, path: string, metadata: string): Promise<void> {
    const file = join(base, path, "SKILL.md"); await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `---\n${metadata}\n---\nPRIVATE SKILL BODY\n`);
}
