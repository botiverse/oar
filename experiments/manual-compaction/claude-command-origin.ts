/* oxlint-disable import/max-dependencies -- Keep the standalone native transport and local provider control together. */
/** Prove why a preflight source read cannot make a queued /compact safe. Local provider only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { claudeRuntime } from "../../packages/oar/src/runtimes/claude/index.js";
import { claudeEnv } from "../../packages/oar/src/runtimes/claude/environment.js";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../../sea-trial/harness/aimock.js";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() >= deadline) { throw new Error("Native observation timed out"); }
    // oxlint-disable-next-line no-await-in-loop -- Poll ordered native observations, with a fixed deadline.
    await delay(10);
  }
}
const installation = await claudeRuntime.installation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const root = await mkdtemp(path.join(tmpdir(), "oar-compact-origin-"));
const cwd = path.join(root, "project");
const config = path.join(root, "config");
await mkdir(cwd); await mkdir(config);
const release = Promise.withResolvers<void>();
let entered = false;
const provider = await startClaudeAimock((mock) => {
  mock.onMessage(/OAR_SLOW/u, async () => { entered = true; await release.promise; return { content: "The ordinary reply completed." }; });
  mock.onMessage(/[\s\S]*/u, { content: "OAR_SUMMARY. Continue the current task." });
}, { captureRaw: true });
const child = spawnLineProcess(installation.command, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence"], {
  cwd, env: claudeEnv({ ...provider.env, CLAUDE_CONFIG_DIR: config }), killTree: true,
});
const messages: JsonRecord[] = [];
child.onLine((line) => { try { const message = asRecord(JSON.parse(line)); if (message !== null) { messages.push(message); } } catch { /* Non-JSON diagnostics are not protocol observations. */ } });
const control = async (subtype: string): Promise<JsonRecord> => {
  const id = randomUUID();
  child.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype } })}\n`);
  await until(() => messages.some((message) => asRecord(message.response)?.request_id === id));
  const result = messages.map((message) => asRecord(message.response)).find((response) => response?.request_id === id);
  assert.ok(result !== undefined && result !== null);
  return result;
};
const send = (text: string): string => {
  const id = randomUUID();
  child.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "", uuid: id })}\n`);
  return id;
};
const finished = async (id: string): Promise<void> => { await until(() => messages.some((message) => message.type === "result" && message.user_message_uuid === id)); };
try {
  await child.spawned;
  const initialized = await control("initialize");
  assert.equal(initialized.subtype, "success");
  await finished(send("OAR_SEED"));
  const active = send("OAR_SLOW");
  await until(() => entered);
  const preflight = await control("initialize");
  const commands = asRecord(preflight.response)?.commands;
  const compact = Array.isArray(commands) ? commands.map((value) => asRecord(value)).filter((command) => command?.name === "compact") : [];
  assert.ok(compact.some((command) => command?.builtin === true));
  const queued = send("/compact");
  await mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "commands", "compact.md"), "---\ndescription: local override\n---\nOAR_CUSTOM_COMPACT_MARKER\n");
  const reloaded = await control("reload_skills");
  assert.equal(reloaded.subtype, "success");
  await until(() => messages.some((message) => message.type === "system" && message.subtype === "commands_changed"));
  release.resolve();
  await finished(active); await finished(queued);
  const customRequest = JSON.stringify(provider.raw).includes("OAR_CUSTOM_COMPACT_MARKER");
  const boundaries = messages.filter((message) => message.type === "system" && message.subtype === "compact_boundary");
  assert.equal(customRequest, true); assert.equal(boundaries.length, 0);
  // Select protocol facts only, never account data from initialize or private filesystem paths.
  console.log(JSON.stringify({ version: installation.version, mode: "reload_while_queued", preflightBuiltin: true, commandsChanged: true, customRequest, compactionBoundaries: boundaries.length }, null, 2));
} finally {
  release.resolve(); child.kill(); await child.exited; await provider.stop(); await rm(root, { recursive: true, force: true });
}
