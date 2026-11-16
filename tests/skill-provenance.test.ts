import { expect, test } from "vitest";
import { projectClaudeSkills } from "../packages/oar/src/runtimes/claude/inventory.js";
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
    { name: "user", source: "npm:fixture", path: "/a", scope: "user", plugin: "npm:fixture" },
    { name: "project", source: "git:example.test/fixture", path: "/b", scope: "project", plugin: "git:example.test/fixture" },
    { name: "temporary", source: "cli", path: "/c", scope: "other" },
  ]);
});
