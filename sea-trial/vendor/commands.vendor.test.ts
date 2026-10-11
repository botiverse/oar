import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { defaultRuntimes } from "../../packages/oar/src/index.js";
import type { CommandEntry, InventoryResult } from "../../packages/oar/src/contracts/inventory.js";

function commands(result: InventoryResult<CommandEntry>): readonly CommandEntry[] {
  assert.equal(result.kind, "ok", JSON.stringify(result));
  return result.items.filter((entry) => entry.name.startsWith("oar-"));
}

test.skipIf(process.env.OAR_TEST !== "pi-aimock")("Pi independently lists extension invocation names and prompt templates, never skills or command bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "oar-pi-commands-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  try {
    for (const directory of [join(agentDir, "extensions"), join(agentDir, "prompts"), join(cwd, ".pi", "prompts"), join(cwd, ".pi", "skills", "oar-skill")]) {
      await mkdir(directory, { recursive: true });
    }
    for (const name of ["one", "two"]) {
      await writeFile(join(agentDir, "extensions", `${name}.js`), `export default function(pi) {
        pi.registerCommand("oar-extension", { description: "${name}", handler: async () => { throw new Error("inventory must not execute commands"); } });
        pi.on("session_start", () => { pi.registerCommand("oar-late-command", { handler: async () => {} }); });
      }`);
    }
    await writeFile(join(agentDir, "prompts", "oar-template.md"), "---\ndescription: User template\nargument-hint: <topic>\n---\nPRIVATE TEMPLATE BODY $1\n");
    await writeFile(join(cwd, ".pi", "prompts", "oar-project.md"), "---\ndescription: Project template\n---\nPRIVATE PROJECT BODY\n");
    await writeFile(join(cwd, ".pi", "skills", "oar-skill", "SKILL.md"), "---\nname: oar-skill\ndescription: Skill only\n---\nPRIVATE SKILL BODY\n");
    const settings = "{}\n";
    await writeFile(join(agentDir, "settings.json"), settings);
    vi.stubEnv("OAR_PI_AGENT_DIR", agentDir);
    const runtime = defaultRuntimes.require("pi");
    const installation = { kind: "available", via: "bundled" } as const;
    const result = await runtime.commands(installation, { cwd });
    assert.deepEqual(commands(result), [
      { name: "oar-extension:1", description: "one", source: "extension" },
      { name: "oar-extension:2", description: "two", source: "extension" },
      { name: "oar-project", description: "Project template", source: "prompt" },
      { name: "oar-template", description: "User template", argumentHint: "<topic>", source: "prompt" },
    ]);
    assert.ok(result.kind === "ok" && !result.partial);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    const skills = await runtime.skills(installation, { cwd });
    assert.ok(skills.kind === "ok" && skills.items.some((skill) => skill.name === "oar-skill"));
    assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), settings);
    const files = await readdir(agentDir);
    assert.equal(files.includes("sessions"), false, "discovery must keep session history in memory");
    assert.equal(files.includes("trust.json"), false, "discovery must not grant project trust");

    await writeFile(join(agentDir, "extensions", "broken.js"), 'throw new Error("PRIVATE EXTENSION FAILURE")');
    const partial = await runtime.commands(installation, { cwd });
    assert.deepEqual(commands(partial), commands(result));
    assert.ok(partial.kind === "ok" && partial.partial);
    assert.equal(JSON.stringify(partial).includes("PRIVATE"), false);

    const other = join(root, "other");
    await mkdir(other);
    const scoped = await runtime.commands(installation, { cwd: other });
    assert.equal(commands(scoped).some((entry) => entry.name === "oar-project"), false);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
}, 60_000);

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("Claude commands come from a prompt-free initialize in the queried workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "oar-claude-commands-"));
  const cwd = join(root, "project");
  try {
    await mkdir(join(cwd, ".claude", "commands"), { recursive: true });
    await mkdir(join(root, "config"));
    await writeFile(join(cwd, ".claude", "commands", "oar-command.md"), "---\ndescription: Inventory fixture\nargument-hint: <topic>\n---\nPRIVATE COMMAND BODY $ARGUMENTS\n");
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "config"));
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
    const runtime = defaultRuntimes.require("claude");
    const installation = await runtime.installation?.();
    assert.ok(installation?.kind === "available", JSON.stringify(installation));
    const result = await runtime.commands(installation, { cwd });
    assert.deepEqual(commands(result), [{ name: "oar-command", description: "Inventory fixture (project)", argumentHint: "<topic>" }]);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    const files = await readdir(join(root, "config"));
    assert.equal(files.includes("projects"), false);
    const other = join(root, "other");
    await mkdir(other);
    assert.deepEqual(commands(await runtime.commands(installation, { cwd: other })), []);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
}, 60_000);
