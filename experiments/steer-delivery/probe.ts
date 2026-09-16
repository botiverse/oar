import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runtimes, awaitTurnEnd, type ControlResult, type RawEvent } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type LLMock } from "../../sea-trial/harness/aimock.js";

const [id] = process.argv.slice(2);
assert.ok(id === "claude" || id === "codex" || id === "pi", "usage: probe.ts claude|codex|pi");
const runtimeId = id;
const marker = "OAR_STEER_DELIVERY_7C92";
const cwd = await mkdtemp(path.join(tmpdir(), "oar-steer-delivery-"));
const requests: { index: number; markerInMessages: boolean }[] = [];
function fixtures(mock: LLMock): void {
  const name = { claude: "Bash", codex: "exec_command", pi: "bash" }[runtimeId];
  const command = "sleep 2; echo oar-boundary";
  const args = id === "codex" ? { cmd: command } : { command };
  mock.onMessage(/[\s\S]*/u, (request: { messages?: readonly { role: string; content: unknown }[] }) => {
    const index = requests.length;
    requests.push({ index, markerInMessages: JSON.stringify(request.messages ?? []).includes(marker) });
    return index === 0 ? { toolCalls: [{ name, arguments: JSON.stringify(args) }] } : { content: "scripted completion" };
  });
}
const env = await ({ claude: startClaudeAimock, codex: startCodexAimock, pi: startPiAimock }[id])(fixtures);
const runtime = runtimes.require(id);
const installation = await runtime.installation?.();
assert.ok(installation?.kind === "available");
const session = await runtime.session(installation, {
  cwd, model: { pi: "aimock/aimock-model", claude: "haiku", codex: "gpt-5.1" }[id],
  env: { ...env.env, CLAUDE_CONFIG_DIR: cwd, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
});
const pending: { steering?: Promise<ControlResult> } = {};
const timeline: { seq: number; kind: string; type?: string; marker?: boolean; native?: unknown }[] = [];
function observe(record: RawEvent): void {
  const native = record.kind === "frame" ? record.body.native : record.body;
  const containsMarker = JSON.stringify(native).includes(marker);
  timeline.push({ seq: record.seq, kind: record.kind, ...(record.kind === "frame" ? { type: record.body.type } : {}),
    ...(containsMarker ? { marker: true } : {}),
    ...(containsMarker || record.kind === "response" ? { native } : {}),
  });
  if (pending.steering === undefined && record.kind === "frame" && record.body.events.some((event) => event.kind === "tool_call_started")) {
    pending.steering = session.steer(marker);
  }
}
const off = session.rawEvents(observe);
const deadline = setTimeout(() => { void session.dispose(); }, 25_000);
try {
  const prompt = await session.prompt("run the tool then finish");
  const outcome = await awaitTurnEnd(session, prompt.request.seq);
  // A late-delivery runtime may start a subsequent turn; allow its provider request to arrive.
  await delay(1500);
  assert.ok(pending.steering !== undefined, "tool boundary was never observed");
  const result = await pending.steering;
  const report = { runtime: id, outcome, steerResponse: result.response.body,
    steerSeq: result.request.seq, requests, timeline };
  const output = path.join(cwd, "observed.json");
  await writeFile(output, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ runtime: id, output, outcome, steerResponse: result.response.body, requests })}\n`);
  assert.equal(result.response.body.kind, "accepted");
  // A missing marker is an observation, not evidence of delivery.
} finally {
  clearTimeout(deadline);
  off();
  await session.dispose();
  await env.stop();
  // Keep only the observation; runtime state stays in the disposable directory.
  await rm(path.join(cwd, ".claude"), { recursive: true, force: true });
}
