import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, onTestFailed, test } from "vitest";
import { qwenRuntime, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startPiAimock, type RawProviderRequest } from "../harness/aimock.js";
import { startQwenAimock } from "../harness/qwen-aimock.js";
import { runTurn } from "./support/asserts.js";
import { isPiBackend, piTestRuntime } from "./support/pi-runtime.js";

const qwenBackend = process.env.OAR_TEST === "qwen-aimock";
const oldPrompts = { systemPrompt: "OAR_OLD_REPLACEMENT_7319", appendSystemPrompt: "OAR_OLD_APPEND_8420" };
const newPrompts = { systemPrompt: "OAR_NEW_REPLACEMENT_9531", appendSystemPrompt: "OAR_NEW_APPEND_0642" };
const markers = [...Object.values(oldPrompts), ...Object.values(newPrompts)];

async function fixture() {
  const qwenEnv = qwenBackend ? await startQwenAimock() : null;
  const env = qwenEnv ?? await startPiAimock(undefined, { captureRaw: true });
  try {
    const runtime = qwenBackend ? qwenRuntime : piTestRuntime;
    const installation = await runtime.installation();
    assert.ok(installation.kind === "available", `installation: ${installation.kind}`);
    const agentDir = process.env.OAR_PI_AGENT_DIR;
    assert.ok(qwenEnv !== null || agentDir !== undefined);
    const cwd = qwenEnv?.cwd ?? path.join(agentDir ?? "", "resume-prompt-project");
    await mkdir(cwd, { recursive: true });
    return {
      raw: env.raw,
      open: async (options: Partial<SessionOptions>) => runtime.session(installation, {
        cwd, ...(!qwenBackend ? { model: "aimock/aimock-model" } : {}), ...options, env: { ...env.env },
      }),
      stop: async () => env.stop(),
    };
  } catch (error) {
    await env.stop();
    throw error;
  }
}

/** Inspect native request fields, excluding saved user/assistant history from the prompt comparison. */
function requestsForTurn(requests: readonly RawProviderRequest[], input: string) {
  return requests.flatMap(({ body }) => {
    const request = asRecord(body);
    const messages = Array.isArray(request?.messages) ? request.messages.map(asRecord) : [];
    // Qwen's post-reply memory extraction also carries the conversation, but
    // its last user message asks for memory extraction, not this turn's input.
    const content = messages.findLast((message) => message?.role === "user")?.content;
    const texts = typeof content === "string" ? [content] : (Array.isArray(content) ? content.map((part) => asRecord(part)?.text) : []);
    if (!texts.includes(input)) { return []; }
    const system = request?.system;
    return [{
      system: JSON.stringify(system ?? messages.filter((message) => message?.role === "system" || message?.role === "developer")),
      history: JSON.stringify(messages.filter((message) => message?.role === "user" || message?.role === "assistant")),
    }];
  });
}

const cases = [
  { name: "replacement", keys: ["systemPrompt"] },
  { name: "append", keys: ["appendSystemPrompt"] },
  { name: "replacement and append", keys: ["systemPrompt", "appendSystemPrompt"] },
] as const;

describe.skipIf(!qwenBackend && !isPiBackend)("Qwen and Pi resumed prompt options", () => {
  test.each(cases)("$name is reapplied on resume and not restored when omitted", async ({ name, keys }) => {
    const f = await fixture();
    const sessions: Session[] = [];
    onTestFailed(async () => {
      await mkdir("oar-trial-run/resume-prompts", { recursive: true });
      await writeFile(`oar-trial-run/resume-prompts/${process.env.OAR_TEST ?? "unknown"}-${name}.json`,
        JSON.stringify({ provider: f.raw, records: sessions.map((session) => session.records()) }, null, 2));
    });
    try {
      const steps = [
        { name: "initial", prompts: Object.fromEntries(keys.map((key) => [key, oldPrompts[key]])) },
        { name: "replacement", prompts: Object.fromEntries(keys.map((key) => [key, newPrompts[key]])) },
        { name: "omission", prompts: {} },
      ];
      let resume: string | undefined = undefined;
      const previousInputs: string[] = [];
      for (const step of steps) {
        const before = f.raw.length;
        const input = `OAR_RESUME_PROMPT_TURN_${step.name}`;
        const session = await f.open({ ...step.prompts, ...(resume === undefined ? {} : { resume }) });
        sessions.push(session);
        try {
          if (resume !== undefined) { expect(session.id).toBe(resume); }
          expect(await runTurn(session, input)).toEqual({ kind: "completed" });
        } finally { await session.dispose(); }
        resume = session.id;
        const requests = requestsForTurn(f.raw.slice(before), input);
        expect(requests.length, `${step.name}: a fresh raw provider request must be observed`).toBeGreaterThan(0);
        for (const { system, history } of requests) {
          for (const previous of previousInputs) { expect(history).toContain(previous); }
          expect(system).not.toBe("[]");
          expect(system).not.toBe('""');
          expect(markers.filter((marker) => system.includes(marker)).toSorted()).toEqual(Object.values(step.prompts).toSorted());
        }
        previousInputs.push(input);
      }
    } finally { await f.stop(); }
  }, 120_000);
});
