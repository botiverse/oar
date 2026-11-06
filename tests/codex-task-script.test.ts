import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../sea-trial/harness/aimock.js";
import { codexTaskIsResumed, codexTaskRecipient, codexTaskRequest } from "../sea-trial/vendor/support/codex-task-request.js";
import { codexTaskRootReply } from "../sea-trial/vendor/support/codex-task-script.js";

const rootInput = { role: "user", content: "TASK_ROOT" };
const followup = { role: "user", content: "PARENT_FOLLOWUP" };
const peer = { type: "agent_message", author: "/root/b", recipient: "/root", content: [{ type: "input_text", text: "CHILD_B_DONE" }] };
const result = (id: string): unknown => ({ type: "function_call_output", call_id: id, output: "{}" });
const childInput = (text: string): unknown[] => [{ type: "agent_message", recipient: "/root/a", content: [{ type: "input_text", text: "Message Type: NEW_TASK" }, { type: "encrypted_content", encrypted_content: text }] }];

async function providerUrl(env: NodeJS.ProcessEnv | undefined): Promise<string> {
  const home = env?.CODEX_HOME; assert.ok(home !== undefined);
  const config = await readFile(path.join(home, "config.toml"), "utf8");
  const url = /^base_url = "(?<url>[^"]+)"$/mu.exec(config)?.groups?.url; assert.ok(url !== undefined);
  return url;
}

async function reply(url: string, input: readonly unknown[]): Promise<unknown> {
  const response = await fetch(`${url}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", stream: false, input }), signal: AbortSignal.timeout(5000) });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const output = asRecord(body)?.output; assert.ok(Array.isArray(output));
  const item = asRecord(output[0]);
  const content = item?.content;
  if (item?.type === "function_call") { return item.call_id; }
  return Array.isArray(content) ? asRecord(content[0])?.text : undefined;
}

test.each([
  { name: "initial spawn", input: [rootInput], action: "spawn_a", after: "spawn_b" },
  { name: "peer spawn", input: [rootInput, result("spawn_a")], action: "spawn_b", after: "PARENT_OK" },
  { name: "child follow-up", input: [rootInput, result("spawn_a"), result("spawn_b"), followup], action: "followup_a", after: "PARENT_OK" },
])("$name survives replay before execution and is not repeated after its result", async ({ input, action, after }) => {
  const provider = await startCodexAimock(mock => { mock.on({ predicate: () => true }, codexTaskRootReply); }, { warmHome: false, rewriteRequest: codexTaskRequest });
  try {
    const url = await providerUrl(provider.env);
    expect(await reply(url, input)).toBe(action);
    expect(await reply(url, [...input, peer])).toBe(action);
    expect(await reply(url, [...input, peer, result(action)])).toBe(after);
    expect(await reply(url, [...input, peer, result(action), peer])).toBe(after);
  } finally { await provider.stop(); }
});

test("child phases follow the task payload even when requests arrive out of order", async () => {
  const provider = await startCodexAimock(mock => {
    mock.on({ predicate: () => true }, request => ({ content: `${String(codexTaskRecipient(request))}:${String(codexTaskIsResumed(request))}` }));
  }, { warmHome: false, rewriteRequest: codexTaskRequest });
  try {
    const url = await providerUrl(provider.env);
    expect(await reply(url, childInput("TASK_CHILD_A_RESUME"))).toBe("/root/a:true");
    expect(await reply(url, childInput("TASK_CHILD_A"))).toBe("/root/a:false");
    expect(await reply(url, childInput("TASK_CHILD_A_RESUME"))).toBe("/root/a:true");
  } finally { await provider.stop(); }
});
