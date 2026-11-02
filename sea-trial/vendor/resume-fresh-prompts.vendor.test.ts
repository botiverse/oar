import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, onTestFailed, test } from "vitest";
import { qwenRuntime, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { startPiAimock } from "../harness/aimock.js";
import { startQwenAimock } from "../harness/qwen-aimock.js";
import { runTurn } from "./support/asserts.js";
import { isPiBackend, piTestRuntime } from "./support/pi-runtime.js";
import { oldPrompts, newPrompts, promptMarkers, promptSemantics, requestsForTurn, resumedMarker, resumeCompaction, type PromptKey } from "./support/resumed-prompts.js";

const qwenBackend = process.env.OAR_TEST === "qwen-aimock";
async function fixture() {
  const compaction = resumeCompaction();
  const qwenEnv = qwenBackend ? await startQwenAimock(compaction.configure) : null;
  const env = qwenEnv ?? await startPiAimock(compaction.configure, {
    captureRaw: true, contextWindow: 100_000,
    settings: { compaction: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 500 } },
  });
  try {
    const runtime = qwenBackend ? qwenRuntime : piTestRuntime;
    const installation = await runtime.installation();
    assert.ok(installation.kind === "available", `installation: ${installation.kind}`);
    const agentDir = process.env.OAR_PI_AGENT_DIR;
    assert.ok(qwenEnv !== null || agentDir !== undefined);
    const cwd = qwenEnv?.cwd ?? path.join(agentDir ?? "", "resume-prompt-project");
    await mkdir(cwd, { recursive: true });
    return {
      runtime, raw: env.raw, compaction,
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

async function checkStep(f: Awaited<ReturnType<typeof fixture>>, session: Session, keys: readonly PromptKey[], name: string, saved: Readonly<Record<PromptKey, string | undefined>>, previousInput: string | undefined) {
  const supplied = name === "replacement" ? newPrompts : undefined;
  for (const compacted of name === "initial" ? [false] : [false, true]) {
    const summariesBefore = f.compaction.summaries.length;
    if (compacted) {
      f.compaction.arm();
      expect(await runTurn(session, `OAR_RESUME_RAISE_USAGE_${name}`)).toEqual({ kind: "completed" });
      // Qwen exposes native /compress on stream-json. Pi compacts
      // automatically before the next request when usage is high.
      if (qwenBackend) {
        const beforeCompact = session.records().length;
        expect(await runTurn(session, "/compress")).toEqual({ kind: "completed" });
        const native = session.records().slice(beforeCompact).filter((record) => record.kind === "frame" && record.body.type === "assistant");
        const completion = /Context compressed \(~?(\d+) -> ~?(\d+)\)\./u.exec(JSON.stringify(native));
        expect(completion, "Qwen must report native compression completion").not.toBeNull();
        expect(Number(completion?.[2])).toBeLessThan(Number(completion?.[1]));
      }
    }
    const before = f.raw.length;
    const input = `OAR_RESUME_PROMPT_TURN_${name}_${String(compacted)}`;
    expect(await runTurn(session, input)).toEqual({ kind: "completed" });
    const requests = requestsForTurn(f.raw.slice(before), input);
    expect(requests.length, `${name}: a fresh raw provider request must be observed`).toBeGreaterThan(0);
    if (compacted) { expect(f.compaction.summaries.length, "native summarizer must run").toBeGreaterThan(summariesBefore); }
    for (const { system, history } of requests) {
      if (!compacted && previousInput !== undefined) { expect(history).toContain(previousInput); }
      if (compacted) { expect(history).toContain(f.compaction.summaries.at(-1)); }
      expect(system.length).toBeGreaterThan(50);
      const expected = keys.flatMap((key) => name === "initial" ? [oldPrompts[key]] : resumedMarker(promptSemantics(f.runtime, key), { saved: saved[key], provided: supplied?.[key] }, compacted));
      expect(promptMarkers.filter((marker) => system.includes(marker)).toSorted()).toEqual(expected.toSorted());
    }
    previousInput = input;
  }
  assert.ok(previousInput !== undefined);
  // A later resume inherits the last effective value, which may be the new
  // prompt supplied on this resume rather than the original seed marker.
  const latest = requestsForTurn(f.raw, previousInput).at(-1)?.system ?? "";
  const nextSaved = { ...saved };
  for (const key of keys) { nextSaved[key] = [oldPrompts[key], newPrompts[key]].find((marker) => latest.includes(marker)); }
  return { input: previousInput, saved: nextSaved };
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
      let previousInput: string | undefined = undefined;
      let saved: Record<PromptKey, string | undefined> = { systemPrompt: undefined, appendSystemPrompt: undefined };
      for (const step of steps) {
        const session = await f.open({ ...step.prompts, ...(resume === undefined ? {} : { resume }) });
        sessions.push(session);
        try {
          if (resume !== undefined) { expect(session.id).toBe(resume); }
          const observed = await checkStep(f, session, keys, step.name, saved, previousInput);
          previousInput = observed.input;
          saved = observed.saved;
        } finally { await session.dispose(); }
        resume = session.id;
      }
    } finally { await f.stop(); }
  }, 120_000);
});
