/** Check the latest Qwen stream for native task signals with a local provider. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { qwenRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { startQwenAimock } from "../../sea-trial/harness/qwen-aimock.js";

let rootCalls = 0;
const requests: unknown[] = [];
const provider = await startQwenAimock(mock => {
  mock.on({ predicate: () => true }, async request => {
    requests.push(request);
    const user = JSON.stringify(request.messages.findLast(message => message.role === "user"));
    if (user.includes("TASK_CHILD_QWEN")) { await delay(200); return { content: "QWEN_CHILD_DONE" }; }
    rootCalls += 1;
    if (rootCalls === 1) { return { toolCalls: [{ id: "spawn", name: "agent", arguments: JSON.stringify({ subagent_type: "general-purpose", description: "Qwen native child", prompt: "TASK_CHILD_QWEN", run_in_background: true }) }] }; }
    return { content: "PARENT_OK" };
  });
});
const installation = await qwenRuntime.installation(); assert.ok(installation.kind === "available" && installation.via === "executable");
const session = await qwenRuntime.session(installation, { cwd: provider.cwd, env: provider.env });
const output = path.resolve(process.argv[2] ?? "oar-trial-run/task-controls-qwen");
try {
  const outcome = await promptAndWait(session, "TASK_ROOT_QWEN", { timeoutMs: 30_000 });
  await delay(1000);
  const frames = session.records().filter(record => record.kind === "frame" && /task_/u.test(record.body.type));
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "result.json"), JSON.stringify({ version: installation.version, outcome: outcome.kind, frames }, null, 2));
  await writeFile(path.join(output, "requests.json"), JSON.stringify(requests, null, 2));
  console.log(JSON.stringify({ version: installation.version, outcome: outcome.kind, frames }));
} finally { await session.dispose(); await provider.stop(); }
