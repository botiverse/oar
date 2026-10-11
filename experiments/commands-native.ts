/** Native command discovery, without model prompts or an account.
 * pnpm tsx experiments/commands-native.ts [claude executable]
 * Uses an isolated Pi agent directory and Claude configuration. See the dated report.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { claudeEnv } from "../packages/oar/src/runtimes/claude/environment.js";

async function piCommands(root: string): Promise<void> {
  const cwd = join(root, "project");
  const agentDir = join(root, "pi");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(agentDir, "prompts"), { recursive: true });
  await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
  await Promise.all(["one", "two"].map(async (name) => {
    await writeFile(join(agentDir, "extensions", `${name}.js`),
      `export default function(pi) { pi.registerCommand("oar-command", { description: "${name}", handler: async () => {} }); }`);
  }));
  await writeFile(join(agentDir, "prompts", "oar-template.md"), "---\ndescription: Template\nargument-hint: <topic>\n---\nReview $1\n");
  await writeFile(join(cwd, ".pi", "prompts", "oar-project.md"), "---\ndescription: Project template\n---\nProject $ARGUMENTS\n");
  const services = await createAgentSessionServices({ cwd, agentDir });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd) });
  try {
    const commands = session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.name, invocationName: command.invocationName, description: command.description,
      source: command.sourceInfo.source, scope: command.sourceInfo.scope,
    }));
    const { prompts, diagnostics } = session.resourceLoader.getPrompts();
    const templates = prompts.map((template) => ({
      name: template.name, description: template.description, argumentHint: template.argumentHint,
      source: template.sourceInfo.source, scope: template.sourceInfo.scope,
    }));
    assert.deepEqual(commands.filter((command) => command.name === "oar-command").map((command) => command.invocationName), ["oar-command:1", "oar-command:2"]);
    assert.equal(templates.find((template) => template.name === "oar-template")?.argumentHint, "<topic>");
    assert.ok(templates.some((template) => template.name === "oar-project"));
    console.log(JSON.stringify({ runtime: "pi", commands, templates, promptDiagnostics: diagnostics.length,
      extensionErrors: session.resourceLoader.getExtensions().errors.length }));
  } finally { session.dispose(); }
}

async function claudeCommands(root: string, executable: string): Promise<void> {
  const cwd = join(root, "project");
  const home = join(root, "claude-home");
  await mkdir(join(cwd, ".claude", "commands"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(cwd, ".claude", "commands", "oar-command.md"), "---\ndescription: OAR fixture\nargument-hint: <topic>\n---\nReview $ARGUMENTS\n");
  const child = spawnLineProcess(executable, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"], {
    cwd, env: { ...claudeEnv(), HOME: home, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
  });
  const response = Promise.withResolvers<JsonRecord>();
  const timer = setTimeout(() => { response.reject(new Error("Claude initialize timed out")); }, 30_000);
  child.onLine((line) => {
    const value = asRecord(parseJson(line));
    const answer = asRecord(value?.response);
    if (value?.type === "control_response" && answer?.request_id === "inventory") {
      if (answer.subtype === "success") { response.resolve(asRecord(answer.response) ?? {}); }
      else { response.reject(new Error("Claude initialize failed")); }
    }
  });
  child.onExit(() => { response.reject(new Error("Claude exited")); });
  try {
    await child.spawned;
    child.write(`${JSON.stringify({ type: "control_request", request_id: "inventory", request: { subtype: "initialize" } })}\n`);
    const payload = await response.promise;
    assert.ok(Array.isArray(payload.commands), "initialize must report commands");
    const commands = payload.commands.map(asRecord);
    const fixture = commands.find((command) => command?.name === "oar-command");
    assert.ok(fixture, "project command must appear");
    const fields = commands.flatMap((command) => Object.keys(command ?? {}));
    console.log(JSON.stringify({ runtime: "claude", count: commands.length,
      commandFields: [...new Set(fields)].toSorted(),
      builtins: commands.filter((command) => command?.builtin === true).map((command) => ({ name: command?.name, aliases: command?.aliases })), fixture }));
  } finally { clearTimeout(timer); child.kill(); await child.exited; }
}

const root = await mkdtemp(join(tmpdir(), "oar-commands-"));
try {
  await piCommands(root);
  if (process.argv[2] !== undefined) { await claudeCommands(root, resolve(process.argv[2])); }
} finally { await rm(root, { recursive: true, force: true }); }
