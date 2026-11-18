/* oxlint-disable eslint/no-await-in-loop -- Each native turn must finish before its context readback and the next prompt. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startQwenAimock } from "../../sea-trial/harness/qwen-aimock.js";
import { launchQwen } from "../../packages/oar/src/runtimes/qwen/launch.js";
import { closeQwen } from "../../packages/oar/src/runtimes/qwen/close.js";
import { qwenControl } from "../../packages/oar/src/runtimes/qwen/control.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const command = process.env.OAR_QWEN_BIN;
assert.ok(command !== undefined && command.length > 0, "Set OAR_QWEN_BIN to the selected native executable");
const output = process.argv[2] ?? "oar-trial-run/qwen-context-cost";
const mode = process.argv[3] ?? "query";
assert.ok(["query", "no-query", "memory-off"].includes(mode), "Use query, no-query or memory-off");
const env = await startQwenAimock();
const frames: unknown[] = [];
const samples: unknown[] = [];
const sessionId = randomUUID();

async function run(resume: boolean, turns: number): Promise<void> {
  assert.ok(command !== undefined && command.length > 0);
  const child = await launchQwen(command, sessionId, { cwd: env.cwd, env: env.env, ...(resume ? { resume: sessionId } : {}) });
  const control = qwenControl(child);
  let result: ((value: unknown) => void) | undefined = undefined;
  child.onLine(line => {
    const message = asRecord(parseJson(line));
    if (message === null) { return; }
    frames.push({ direction: "fromRuntime", at: Date.now(), native: message });
    control.consume(message);
    if (message.type === "result" && (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined)) { result?.(message); }
  });
  child.onExit(() => { control.end(); });
  const request = async (payload: JsonRecord): Promise<JsonRecord> => {
    frames.push({ direction: "toRuntime", at: Date.now(), native: payload });
    const response = await control.request(payload);
    return response;
  };
  try {
    samples.push({ resume, phase: "initialize", native: await request({ subtype: "initialize" }) });
    for (let index = 0; index < turns; index += 1) {
      const waiting = Promise.withResolvers<unknown>();
      result = waiting.resolve;
      const timer = setTimeout(() => { waiting.reject(new Error("Native turn timed out")); }, 45_000);
      const user = { type: "user", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: `CONTEXT_PROBE_${resume ? "RESUME" : "FRESH"}_${String(index)}` }] } };
      frames.push({ direction: "toRuntime", at: Date.now(), native: user });
      child.write(`${JSON.stringify(user)}\n`);
      let answer: unknown = undefined;
      try { answer = await waiting.promise; }
      finally { clearTimeout(timer); result = undefined; }
      const requestStart = env.raw.length;
      const start = performance.now();
      const context = mode === "no-query" ? await delay(200, null) : await request({ subtype: "get_context_usage", show_details: false });
      samples.push({ resume, index, elapsedMs: performance.now() - start, requestStart, requestEnd: env.raw.length, result: answer, context });
    }
  } finally { control.end(); await closeQwen(child); }
}

try {
  if (mode === "memory-off") {
    const settingsPath = path.join(env.env.HOME ?? "", ".qwen", "settings.json");
    const settings = asRecord(JSON.parse(await readFile(settingsPath, "utf8")));
    await writeFile(settingsPath, JSON.stringify({ ...settings, memory: { enableManagedAutoMemory: false } }));
  }
  await run(false, 2);
  await run(true, 1);
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "raw.json"), JSON.stringify({ mode, samples, frames, providerRequests: env.raw }, null, 2));
  await env.stop();
}
