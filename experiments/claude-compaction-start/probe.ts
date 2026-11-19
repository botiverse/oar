import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { claudeRuntime, promptAndWait } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../../sea-trial/harness/aimock.js";

const [binary, mode] = process.argv.slice(2);
assert.ok(binary !== undefined && (mode === "manual" || mode === "manual-failure" || mode === "overflow" || mode === "slow-overflow" || mode === "high-usage"));
const manual = mode === "manual" || mode === "manual-failure";
const overflow = mode === "overflow" || mode === "slow-overflow";
const root = await mkdtemp(path.join(tmpdir(), "oar-claude-compact-start-"));
const file = path.join(root, "seed.txt");
await writeFile(file, "North Wharf");
const requests: string[] = [];
const provider = await startClaudeAimock(mock => {
  mock.on({ predicate: () => true }, async request => {
    if (!manual && requests.length === 1) {
      const input = mode === "high-usage" ? 195_000 : 123;
      requests.push(`tool call with ${String(input)} input tokens`);
      return { toolCalls: [{ name: "Read", arguments: JSON.stringify({ file_path: file }) }], usage: { input_tokens: input, output_tokens: 12 } };
    }
    if (overflow && requests.length === 2) {
      assert.equal(request.messages.at(-1)?.role, "tool");
      requests.push("HTTP 400 after tool result");
      return { status: 400, error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } };
    }
    if (mode === "manual-failure" && requests.length > 0) {
      requests.push("HTTP 400 on summary");
      return { status: 400, error: { type: "invalid_request_error", message: "Synthetic summary request rejected" } };
    }
    const slowSummary = mode === "slow-overflow" && requests.length === 3;
    if (slowSummary) { await delay(34_000); }
    requests.push(slowSummary ? "streamed summary" : "text");
    const content = slowSummary ? "North Wharf has one synthetic project. ".repeat(45) : "The local fixture recorded the conversation.";
    return { content, usage: { input_tokens: 123, output_tokens: 12 } };
  }, { chunkSize: 16, streamingProfile: { tps: 60 } });
});
try {
  const session = await claudeRuntime.session({ kind: "available", via: "executable", command: path.resolve(binary) }, {
    cwd: root, model: "claude-sonnet-4-5-20250929", env: { ...provider.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ANTHROPIC_AUTH_TOKEN: null, CLAUDE_CODE_OAUTH_TOKEN: null },
  });
  try {
    const seed = await promptAndWait(session, "Remember the synthetic project name North Wharf.");
    assert.ok(seed.kind === "ended" && seed.outcome.kind === "completed");
    const since = session.records().length;
    if (manual) {
      assert.ok(session.compact !== undefined);
      const result = await session.compact({ timeoutMs: 30_000 });
      assert.equal(result.kind, mode === "manual-failure" ? "failed" : "completed");
    } else {
      const run = await promptAndWait(session, "What project name did I give?");
      assert.ok(run.kind === "ended" && run.outcome.kind === "completed");
    }
    const frames = session.records().slice(since).flatMap(record => {
      if (record.kind !== "frame" || !["system/status", "system/compact_boundary"].includes(record.body.type)) { return []; }
      const native = asRecord(record.body.native);
      return [{ type: record.body.type, status: native?.status, compactResult: native?.compact_result, compactError: native?.compact_error, chars: native?.compact_output_chars, trigger: asRecord(native?.compact_metadata)?.trigger,
        ...(native?.status === "compacting" ? { nativeFields: Object.keys(native).toSorted() } : {}), events: record.body.events }];
    });
    const compactions = frames.flatMap(frame => frame.events).filter(event => event.kind === "compaction_started" || event.kind === "compaction_ended");
    if (mode === "slow-overflow") { assert.ok(frames.filter(frame => frame.status === "compacting").length >= 2); }
    if (mode === "manual-failure") {
      const failure = frames.find(frame => frame.compactResult === "failed");
      assert.ok(failure !== undefined && typeof failure.compactError === "string");
      assert.ok(!frames.some(frame => frame.type === "system/compact_boundary"));
      assert.deepEqual(compactions, [{ kind: "compaction_started" }, { kind: "compaction_ended", outcome: "failed", reason: failure.compactError }]);
    } else {
      assert.deepEqual(compactions, mode === "high-usage" ? [] : [
        { kind: "compaction_started" }, { kind: "compaction_ended", outcome: "completed", trigger: manual ? "manual" : "auto" },
      ]);
    }
    console.log(JSON.stringify({ mode, requests, frames }, null, 2));
  } finally { await session.dispose(); }
} finally { await provider.stop(); await rm(root, { recursive: true, force: true }); }
