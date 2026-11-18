import { expect, test } from "vitest";
import { projectClaudeSkillCatalog, projectClaudeSkills } from "../packages/oar/src/runtimes/claude/inventory.js";
import { projectCodexSkills } from "../packages/oar/src/runtimes/codex/inventory.js";
import { projectGrokSkills } from "../packages/oar/src/runtimes/grok/inventory.js";
import { piRpcSkills } from "../packages/oar/src/runtimes/pi/rpc/readers.js";

test("native provenance maps without replacing source or plugin identity", () => {
  expect(projectClaudeSkills({ skills: { skillFrontmatter: [
    { name: "builtin", source: "built-in" },
    { name: "user", source: "userSettings" },
    { name: "repo", source: "projectSettings", pluginName: "native-plugin" },
    { name: "local", source: "localSettings" },
    { name: "policy", source: "policySettings" },
    { name: "plugin", source: "plugin", pluginName: "native-plugin" },
    ...["flagSettings", "memoryStore", "syncedSkills"].map(source => ({ name: source, source })),
    { name: "new", source: "future", pluginName: "known-plugin" }, { name: "missing" }, { name: "prototype", source: "constructor" },
  ] } })).toEqual([
    { name: "builtin", source: "built-in", scope: "builtin" },
    { name: "user", source: "userSettings", scope: "user" },
    { name: "repo", source: "projectSettings", scope: "project", plugin: "native-plugin" },
    { name: "local", source: "localSettings", scope: "project" },
    { name: "policy", source: "policySettings", scope: "managed" },
    { name: "plugin", source: "plugin", scope: "other", plugin: "native-plugin" },
    ...["flagSettings", "memoryStore", "syncedSkills"].map(source => ({ name: source, source, scope: "other" })),
    { name: "new", source: "future", plugin: "known-plugin" }, { name: "missing" }, { name: "prototype", source: "constructor" },
  ]);
  expect(projectCodexSkills({ data: [{ skills: [
    { name: "system", scope: "system" }, { name: "user", scope: "user", pluginId: "plugin@market" },
    { name: "repo", scope: "repo" }, { name: "admin", scope: "admin" },
    { name: "new", scope: "future", pluginId: "plugin@market" }, { name: "missing", pluginId: null },
  ] }] })).toEqual([
    { name: "system", source: "system", scope: "builtin" }, { name: "user", source: "user", scope: "user", plugin: "plugin@market" },
    { name: "repo", source: "repo", scope: "project" }, { name: "admin", source: "admin", scope: "managed" },
    { name: "new", source: "future", plugin: "plugin@market" }, { name: "missing" },
  ]);
});

test("Grok preserves tagged source identity and does not guess from a skill path", () => {
  expect(projectGrokSkills({ skills: [
    ...["bundled", "user", "project", "server", "configToml"].map(type => ({ name: type, source: { type } })),
    { name: "plugin", source: { type: "plugin", plugin_name: "native-plugin", path: "/skills/a" } },
    { name: "legacy", source: "user" }, { name: "unknown", source: { type: "future", path: "/home/.grok/skills/a" } },
    { name: "missing" },
  ] })).toEqual([
    { name: "bundled", source: "bundled", scope: "builtin" }, { name: "user", source: "user", scope: "user" },
    { name: "project", source: "project", scope: "project" }, { name: "server", source: "server", scope: "other" },
    { name: "configToml", source: "configToml", scope: "other" },
    { name: "plugin", source: "plugin", scope: "other", plugin: "native-plugin", path: "/skills/a" },
    { name: "legacy", source: "user", scope: "user" }, { name: "unknown", source: "future", path: "/home/.grok/skills/a" },
    { name: "missing" },
  ]);
});

test("Pi RPC retains package identity independently of user, project and temporary scope", () => {
  expect(piRpcSkills([
    { name: "skill:user", source: "skill", sourceInfo: { source: "npm:fixture", path: "/a", scope: "user", origin: "package" } },
    { name: "skill:project", source: "skill", sourceInfo: { source: "git:example.test/fixture", path: "/b", scope: "project", origin: "package" } },
    { name: "skill:temporary", source: "skill", sourceInfo: { source: "cli", path: "/c", scope: "temporary", origin: "top-level" } },
  ])).toEqual([
    { name: "user", userInvocable: true, source: "npm:fixture", path: "/a", scope: "user", plugin: "npm:fixture" },
    { name: "project", userInvocable: true, source: "git:example.test/fixture", path: "/b", scope: "project", plugin: "git:example.test/fixture" },
    { name: "temporary", userInvocable: true, source: "cli", path: "/c", scope: "other" },
  ]);
});

test("Claude catalog joins native descriptions and invocability and keeps model-hidden labeled commands", () => {
  const context = { skills: { totalSkills: 8, includedSkills: 8, skillFrontmatter: [
    { name: "deploy", source: "projectSettings", path: "/w/.claude/commands/deploy.md" },
    { name: "user-skill", source: "userSettings", path: "/h/.claude/skills/user-skill/SKILL.md" },
    { name: "dataviz", source: "syncedSkills" },
    { name: "review", source: "projectSettings" },
    { name: "twice", source: "userSettings" },
    { name: "local-skill", source: "localSettings" },
    { name: "same", source: "projectSettings", path: "/w/.claude/skills/a/SKILL.md" },
    { name: "same", source: "projectSettings", path: "/w/.claude/skills/b/SKILL.md" },
  ] } };
  const initialized = { commands: [
    { name: "deploy", description: "Deploy it (project)", argumentHint: "env" },
    { name: "dataviz", description: "Charts (project)" },
    { name: "review", description: "Built-in review", builtin: true },
    { name: "hidden-skill", description: "Hidden one (project)" },
    { name: "ucmd", description: "User cmd (user)" },
    { name: "same", description: "Only one of the two (project)" },
    { name: "twice", description: "A (user)" },
    { name: "twice", description: "B (user)" },
    { name: "mcp-prompt", description: "From a server" },
    { name: "init", description: "Initialize", builtin: true },
    "not a row",
  ] };
  // Frontmatter descriptions OAR read from each file; deploy's file matches its command.
  const files = new Map([["/w/.claude/commands/deploy.md", "Deploy it"], ["/h/.claude/skills/user-skill/SKILL.md", "User skill"]]);
  expect(projectClaudeSkillCatalog(context, initialized, files)).toEqual({ partial: false, items: [
    { name: "deploy", source: "projectSettings", scope: "project", path: "/w/.claude/commands/deploy.md", description: "Deploy it", userInvocable: true },
    // user-invocable: false in its frontmatter, so Claude does not list it as a command.
    { name: "user-skill", source: "userSettings", scope: "user", path: "/h/.claude/skills/user-skill/SKILL.md", userInvocable: false },
    // The label is stripped only when it names the entry's own scope.
    { name: "dataviz", source: "syncedSkills", scope: "other", description: "Charts (project)", userInvocable: true },
    // A builtin command of the same name never describes a project skill, and
    // `/review` runs the builtin, so whether the skill is runnable is unknown.
    { name: "review", source: "projectSettings", scope: "project" },
    // Listed twice: neither description nor invocability is known.
    { name: "twice", source: "userSettings", scope: "user" },
    // Local settings were not verified, so absence claims nothing.
    { name: "local-skill", source: "localSettings", scope: "project" },
    // Two skills share a name; the one command cannot be told apart, so neither joins it.
    { name: "same", source: "projectSettings", scope: "project", path: "/w/.claude/skills/a/SKILL.md" },
    { name: "same", source: "projectSettings", scope: "project", path: "/w/.claude/skills/b/SKILL.md" },
    { name: "hidden-skill", description: "Hidden one", scope: "project", userInvocable: true },
    { name: "ucmd", description: "User cmd", scope: "user", userInvocable: true },
  ] });
});

test("Claude catalog joins a command only to the skill file it came from", () => {
  const context = { skills: { totalSkills: 3, includedSkills: 3, skillFrontmatter: [
    { name: "renamed", source: "projectSettings", path: "/w/.claude/skills/other-dir/SKILL.md" },
    { name: "pair", source: "projectSettings", path: "/w/.claude/skills/pair-a/SKILL.md" },
    { name: "tool:lint", source: "plugin", pluginName: "tool", path: "/p/tool/skills/lint/SKILL.md" },
  ] } };
  const initialized = { commands: [
    { name: "renamed", description: "Dir differs (project)", aliases: ["other-dir"] },
    // The visible pair-a is not runnable; this command is its model-hidden sibling pair-b.
    { name: "pair", description: "Pair B (project)", aliases: ["pair-b"] },
    { name: "tool:lint", description: "Lint it" },
  ] };
  const files = new Map([
    ["/w/.claude/skills/other-dir/SKILL.md", "Dir differs"],
    ["/w/.claude/skills/pair-a/SKILL.md", "Pair A"],
    ["/p/tool/skills/lint/SKILL.md", "Lint it"],
  ]);
  expect(projectClaudeSkillCatalog(context, initialized, files).items).toEqual([
    // A directory named differently from its skill is listed as the command's alias.
    { name: "renamed", source: "projectSettings", scope: "project", path: "/w/.claude/skills/other-dir/SKILL.md", description: "Dir differs", userInvocable: true },
    // The alias names another directory: not this skill's command, so nothing is known.
    { name: "pair", source: "projectSettings", scope: "project", path: "/w/.claude/skills/pair-a/SKILL.md" },
    // A plugin skill's name carries its plugin prefix; the file is still lint.
    { name: "tool:lint", source: "plugin", scope: "other", plugin: "tool", path: "/p/tool/skills/lint/SKILL.md", description: "Lint it", userInvocable: true },
  ]);
});

test("Claude catalog joins nothing when an unseen same-name file could own the command", () => {
  const context = { skills: { totalSkills: 2, includedSkills: 2, skillFrontmatter: [
    // Visible, not runnable; a model-hidden user skill of the same name owns the command.
    { name: "cross-scope", source: "projectSettings", path: "/w/.claude/skills/cross-scope/SKILL.md" },
    // A legacy command file, not runnable; the hidden skills/cross/SKILL.md owns the command.
    { name: "cross", source: "projectSettings", path: "/w/.claude/commands/cross.md" },
  ] } };
  const initialized = { commands: [
    { name: "cross-scope", description: "Hidden user skill (user)" },
    { name: "cross", description: "Hidden project skill (project)" },
  ] };
  const files = new Map([["/w/.claude/skills/cross-scope/SKILL.md", "Hidden user skill"], ["/w/.claude/commands/cross.md", "Legacy cross"]]);
  expect(projectClaudeSkillCatalog(context, initialized, files).items).toEqual([
    // The label names another scope.
    { name: "cross-scope", source: "projectSettings", scope: "project", path: "/w/.claude/skills/cross-scope/SKILL.md" },
    // The file's own description is not the command's.
    { name: "cross", source: "projectSettings", scope: "project", path: "/w/.claude/commands/cross.md" },
  ]);
});

test("Claude catalog claims nothing it cannot read", () => {
  const context = { skills: { totalSkills: 3, includedSkills: 2, skillFrontmatter: [{ name: "plugin-skill", source: "plugin", pluginName: "p" }] } };
  // No command catalog: no descriptions, no invocability; the context list said it left a skill out.
  expect(projectClaudeSkillCatalog(context, {})).toEqual({ partial: true, items: projectClaudeSkills(context) });
  // An unverified source absent from the commands gets no userInvocable claim.
  expect(projectClaudeSkillCatalog(context, { commands: [] }).items).toEqual([{ name: "plugin-skill", source: "plugin", scope: "other", plugin: "p" }]);
});
