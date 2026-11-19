/** Native control: does OpenCode 2.x apply a session-local OPENCODE_CONFIG_CONTENT agent system prompt and instructions file? */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { opencodeRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/run.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";

const [shape = "v2"] = process.argv.slice(2);
const installation = await opencodeRuntime.installation();
assert.ok(installation.kind === "available" && installation.via === "executable", "Set OAR_OPENCODE_BIN to the selected binary");
const systems: string[] = [];
const fixture = await startOpencodeAimock(mock => {
  mock.on({ predicate: request => (request.tools ?? []).length > 0 }, request => {
    systems.push(JSON.stringify(request.messages.filter(message => message.role === "system")));
    return { content: "Complete" };
  });
});
const dir = await mkdtemp(path.join(os.tmpdir(), "oar-oc2-prompt-"));
const instructions = path.join(dir, "instructions.md");
await writeFile(instructions, "APPEND-MARKER-7731");
const overlay = shape === "v1"
  ? { agent: { build: { prompt: "SYSTEM-MARKER-4410" } }, instructions: [instructions] }
  : { agents: { build: { system: "SYSTEM-MARKER-4410" } }, instructions: [instructions] };
const env = { ...fixture.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay) };
const cwd = fixture.env.HOME ?? "";
try {
  const listed = await runExecutable(installation.command, ["debug", "agents", "--standalone"], { cwd, env: { ...process.env, ...env }, timeoutMs: 30_000 });
  let primary: unknown = listed.stderr.slice(0, 300);
  try {
    const parsed: unknown = JSON.parse(listed.stdout);
    if (Array.isArray(parsed)) { primary = parsed.map(entry => asRecord(entry)).filter(entry => entry?.mode !== "subagent" && entry?.hidden !== true).map(entry => entry?.id); }
  } catch { /* the stderr excerpt stays */ }
  console.log(JSON.stringify({ debugAgents: listed.exitCode, primary }));
  const session = await opencodeRuntime.session(installation, { cwd, env, model: "aimock/aimock-model" });
  try {
    const result = await promptAndWait(session, "Say done", { timeoutMs: 60_000 });
    console.log(JSON.stringify({ outcome: result.kind === "ended" ? result.outcome.kind : result.kind }));
  } finally { await session.dispose(); }
  const text = systems.at(-1) ?? "";
  console.log(JSON.stringify({
    version: installation.version, shape, requests: systems.length,
    systemMarker: text.includes("SYSTEM-MARKER-4410"), appendMarker: text.includes("APPEND-MARKER-7731"),
    builtInPromptPresent: /You are opencode|You are OpenCode/u.test(text),
  }));
} finally { await fixture.stop(); }
