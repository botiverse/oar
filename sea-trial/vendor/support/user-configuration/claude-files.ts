import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "../../../../packages/oar/src/contracts/session.js";

export function configurationHook(marker: string): object {
  // The hook passes through a shell before JavaScript; keep Windows path
  // backslashes out of both parsers rather than escaping them twice.
  const encoded = Buffer.from(marker).toString("base64");
  return { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `"${process.execPath.replaceAll("\\", "/")}" -e "require('node:fs').writeFileSync(Buffer.from('${encoded}', 'base64').toString(), 'ran')"` }] }] } };
}

/** The project lives below HOME to exercise Claude's ancestor-memory walk. */
export async function writeClaudeConfiguration(home: string, userMcp: McpServer): Promise<void> {
  const config = path.join(home, ".claude");
  const cwd = path.join(home, "project");
  const marketplace = path.join(home, "marketplace");
  const plugin = path.join(marketplace, "plugin");
  const { name, ...server } = userMcp;
  const files = {
    [path.join(marketplace, ".claude-plugin", "marketplace.json")]: JSON.stringify({ name: "oar-local-probe", owner: { name: "OAR probe" }, plugins: [{ name: "user-probe", source: "./plugin", description: "local fixture" }] }),
    [path.join(plugin, ".claude-plugin", "plugin.json")]: JSON.stringify({ name: "user-probe", description: "local fixture", version: "1.0.0" }),
    [path.join(plugin, "hooks", "hooks.json")]: JSON.stringify(configurationHook(path.join(home, "plugin-hook"))),
    [path.join(plugin, "skills", "plugin-skill", "SKILL.md")]: "---\nname: plugin-skill\ndescription: OAR_PLUGIN_SKILL_MARKER\n---\nLocal plugin instructions.",
    [path.join(config, "settings.json")]: JSON.stringify({ ...configurationHook(path.join(home, "user-hook")), env: { OAR_USER_CONFIG: "user" }, autoMemoryEnabled: true, autoMemoryDirectory: path.join(config, "memory-probe"), permissions: { deny: ["Bash(OAR_USER_DENY)"] } }),
    [path.join(cwd, ".claude", "settings.json")]: JSON.stringify(configurationHook(path.join(home, "project-hook"))),
    [path.join(config, "CLAUDE.md")]: "OAR_USER_MEMORY_MARKER",
    [path.join(home, "CLAUDE.md")]: "OAR_HOME_MEMORY_MARKER",
    [path.join(home, "CLAUDE.local.md")]: "OAR_HOME_LOCAL_MEMORY_MARKER",
    [path.join(config, "rules", "user-rule.md")]: "OAR_USER_RULE_MARKER",
    [path.join(cwd, "CLAUDE.md")]: "OAR_PROJECT_MEMORY_MARKER",
    [path.join(config, "skills", "user-skill", "SKILL.md")]: "---\nname: user-skill\ndescription: OAR_USER_SKILL_MARKER\n---\nUser skill instructions.",
    [path.join(config, "commands", "user-command.md")]: "---\ndescription: OAR_USER_COMMAND_MARKER\n---\nUser command instructions.",
    [path.join(config, "agents", "user-agent.md")]: "---\nname: user-agent\ndescription: OAR_USER_AGENT_MARKER\n---\nUser agent instructions.",
    [path.join(config, ".claude.json")]: JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { [name]: server } }),
    [path.join(config, "memory-probe", "MEMORY.md")]: "OAR_AUTO_MEMORY_MARKER",
  };
  await Promise.all(Object.entries(files).map(async ([file, text]) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }));
}
