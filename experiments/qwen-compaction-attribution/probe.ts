/* eslint-disable no-await-in-loop -- Native history and control observations must run in order. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { qwenRuntime } from "../../packages/oar/src/index.js";
import type { RawEvent } from "../../packages/oar/src/contracts/records.js";
import { asRecord, asRecordList } from "../../packages/oar/src/shared/json.js";
import { startQwenAimock } from "../../sea-trial/harness/qwen-aimock.js";
import { runTurn } from "../../sea-trial/vendor/support/asserts.js";

const output = process.argv.at(2);
assert.ok(output !== undefined && output.length > 0, "Usage: pnpm tsx experiments/qwen-compaction-attribution/probe.ts OUTPUT_DIRECTORY");
await mkdir(output, { recursive: true });
const installation = await qwenRuntime.installation();
assert.equal(installation.kind, "available");

function projectedText(records: readonly RawEvent[]): string {
  return records.flatMap((record) => record.kind === "frame" ? record.body.events : [])
    .flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("");
}

for (const mode of ["manual", "automatic", "shadowed"] as const) {
  let summaries = 0;
  let status = "MODEL_PLACEHOLDER";
  const env = await startQwenAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, (request) => {
      const last = JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content);
      const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));
      if (last.includes("Then, produce the <state_snapshot> XML.") || system.includes("You are a context summarization assistant.")) {
        summaries++;
        return { content: `<state_snapshot><primary_request_and_intent>OAR_NATIVE_SUMMARY_${String(summaries)}</primary_request_and_intent><current_state>The prior exchanges finished. Continue with the next input.</current_state></state_snapshot>`, usage: { input_tokens: 20_000, output_tokens: 80 } };
      }
      return { content: last.includes("OAR_SAME_STATUS") ? status : `MODEL_BODY_${mode} ${"Ordinary model words. ".repeat(500)}`,
        usage: { input_tokens: last.includes("OAR_HIGH_USAGE") ? 90_000 : 100, output_tokens: 300 } };
    });
  });
  if (mode === "automatic") {
    const settingsPath = path.join(env.env.HOME ?? "", ".qwen", "settings.json");
    const settings = asRecord(JSON.parse(await readFile(settingsPath, "utf8")));
    assert.ok(settings !== null);
    const providers = asRecordList(asRecord(settings.modelProviders)?.openai);
    assert.equal(providers.length, 1);
    for (const provider of providers) {
      provider.generationConfig = { contextWindowSize: 100_000 };
    }
    await writeFile(settingsPath, JSON.stringify(settings));
  }
  if (mode === "shadowed") {
    const commands = path.join(env.env.HOME ?? "", ".qwen", "commands");
    await mkdir(commands);
    await writeFile(path.join(commands, "compress.toml"), 'prompt = "OAR_SHADOW_COMPRESS_MODEL"\n');
  }
  const session = await qwenRuntime.session(installation, { cwd: env.cwd, env: { ...env.env } });
  const steps = [];
  try {
    for (const input of ["OAR_INITIAL", "OAR_HIGH_USAGE", ...(mode === "automatic" ? [] : ["/compress"]), "OAR_AFTER", "OAR_SAME_STATUS"]) {
      const first = session.records().length;
      const firstRequest = env.raw.length;
      const outcome = await runTurn(session, input);
      const records = session.records().slice(first);
      if (input === "/compress" && mode === "manual") {
        const frames = records.filter((record) => record.kind === "frame");
        const match = /Context compressed \([^)]*\)\./u.exec(JSON.stringify(frames));
        assert.ok(match, "native manual compression completion missing");
        [status] = match;
        assert.equal(projectedText(records), status);
      }
      if (mode === "manual" && input === "OAR_SAME_STATUS") {
        assert.equal(projectedText(records), status, "ordinary model output must reproduce the status verbatim");
      }
      if (mode === "shadowed" && input === "/compress") {
        assert.ok(JSON.stringify(env.raw.slice(firstRequest)).includes("OAR_SHADOW_COMPRESS_MODEL"));
        assert.ok(projectedText(records).startsWith("MODEL_BODY_shadowed "));
        assert.equal(summaries, 0, "the overridden command must not compact");
      }
      if (mode !== "shadowed" && input === "OAR_AFTER") {
        assert.ok(summaries > 0);
        assert.ok(JSON.stringify(env.raw.slice(firstRequest)).includes("OAR_NATIVE_SUMMARY_1"), "the next model input must use the native summary");
      }
      assert.ok(!records.some((record) => record.kind === "frame" && record.body.events.some((event) =>
        event.kind === "compaction_started" || event.kind === "compaction_ended")), "record any newly available compaction signal before changing the conclusion");
      steps.push({ input, outcome, summaries, records, requests: env.raw.slice(firstRequest) });
      assert.equal(outcome.kind, "completed");
    }
    assert.equal(summaries > 0, mode !== "shadowed", "native compaction must actually run in both built-in controls");
  } finally {
    await session.dispose();
    await writeFile(path.join(output, `${mode}.json`), JSON.stringify({ installation, mode, summaries, steps }, null, 2));
    await env.stop();
  }
  console.log(JSON.stringify({ mode, summaries, inputs: steps.map(({ input, outcome }) => ({ input, outcome })) }));
}
