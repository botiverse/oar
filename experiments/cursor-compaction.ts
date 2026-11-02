/**
 * BURNS TOKENS through an existing Cursor SDK login.
 * Run: pnpm tsx experiments/cursor-compaction.ts <new-output-directory>
 * One text-only turn, one native manual summary, then a summary cancelled at
 * its first running message. Manual summarization is only a probe trigger;
 * OAR exposes no such control. Logs and failures stay in the private output.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Agent, type InteractionUpdate, type Run, type RunResult, type SDKMessage } from "@cursor/sdk";

interface Observation {
  readonly seq: number;
  readonly at: number;
  readonly phase: string;
  readonly channel: string;
  readonly value: unknown;
}

const [outputArgument] = process.argv.slice(2);
assert.ok(outputArgument !== undefined && outputArgument !== "", "a new output directory is required");
const output = path.resolve(outputArgument);
mkdirSync(output, { mode: 0o700 });
const cwd = path.join(output, "workspace");
mkdirSync(cwd, { mode: 0o700 });
const observations: Observation[] = [];
function log(phase: string, channel: string, value: unknown): void {
  const observation = { seq: observations.length, at: Date.now(), phase, channel, value };
  observations.push(observation);
  appendFileSync(path.join(output, "events.jsonl"), `${JSON.stringify(observation)}\n`, { mode: 0o600 });
}

async function observe(phase: string, run: Run, cancelSummary = false): Promise<{ result: RunResult; messages: SDKMessage[] }> {
  const messages: SDKMessage[] = [];
  log(phase, "returned", { id: run.id });
  const stream = (async (): Promise<void> => {
    for await (const message of run.stream()) {
      messages.push(message);
      log(phase, "stream", message);
      if (cancelSummary && message.type === "summary" && message.status === "running") {
        log(phase, "cancel", "requested");
        await run.cancel();
        log(phase, "cancel", "returned");
      }
    }
    log(phase, "stream-end", null);
  })();
  const waiting = (async (): Promise<RunResult> => { const result = await run.wait(); log(phase, "wait", result); return result; })();
  try {
    const [, result] = await Promise.all([stream, waiting]);
    return { result, messages };
  } finally {
    if (run.status === "running") { await run.cancel(); }
  }
}

async function probe(): Promise<void> {
  const agent = await Agent.create({
    model: { id: process.env.OAR_TEST_MODEL ?? "gpt-5.4-nano" }, tools: [],
    local: { cwd, settingSources: [], sandboxOptions: { enabled: false } },
  });
  try {
    const deltas: InteractionUpdate[] = [];
    const run = await agent.send("Remember the exact token SANDPIPER-410. Reply only STORED. Do not use tools.", {
      onDelta: ({ update }) => { deltas.push(update); log("normal", "delta", update); },
    });
    const normal = await observe("normal", run);
    assert.equal(normal.result.status, "finished");
    const deltaText = deltas.flatMap((delta) => delta.type === "text-delta" ? [delta.text] : []).join("");
    const streamText = normal.messages.flatMap((message) => message.type === "assistant"
      ? message.message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("");
    assert.equal(deltaText, streamText);
    assert.equal(deltaText.trim(), "STORED");
    const summary = await observe("summary", await agent.summarize());
    assert.equal(summary.result.status, "finished");
    assert.deepEqual(summary.messages.flatMap((message) => message.type === "summary" ? [message.status] : []), ["running", "completed"]);
    const cancelled = await observe("summary-cancel", await agent.summarize(), true);
    assert.equal(cancelled.result.status, "cancelled");
    assert.deepEqual(cancelled.messages.flatMap((message) => message.type === "summary" ? [message.status] : []), ["running"]);
    writeFileSync(path.join(output, "report.json"), `${JSON.stringify({ normal: normal.result, summary: summary.result, cancelled: cancelled.result, deltaText, streamText }, null, 2)}\n`, { mode: 0o600 });
  } finally { await agent[Symbol.asyncDispose](); }
}

// A parent process bounds native startup and teardown too. It keeps the child
// log on failure, without relying on a wedged SDK to honor cancellation.
const { spawnSync } = await import("node:child_process");
if (process.argv[3] === "--child") {
  await probe();
} else {
  // The child initializes a separate evidence directory under this one.
  const child = spawnSync(process.execPath, [...process.execArgv, import.meta.filename, path.join(output, "native"), "--child"], {
    timeout: 120_000, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  writeFileSync(path.join(output, "process.log"), `${child.stdout}${child.stderr}`, { mode: 0o600 });
  writeFileSync(path.join(output, "process.json"), `${JSON.stringify({ status: child.status, signal: child.signal, error: child.error?.message })}\n`, { mode: 0o600 });
  assert.equal(child.status, 0, `native probe failed; inspect ${output}`);
  console.log(`PASS Cursor dual stream and compaction; evidence: ${output}`);
}
