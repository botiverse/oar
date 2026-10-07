/** Compare Claude settings and steer delivery against a scripted provider; no real model calls.
 * Run with OAR_CLAUDE_BIN pointing at the binary under investigation.
 * Only applied settings, event kinds and request summaries are printed; merged settings stay private.
 * Observed 2026-10-07, Linux x64, Claude 2.1.292 and 2.1.293:
 * - haiku changes from Haiku 4.5 (no effort) to Haiku 5.5 (low reaches the API).
 * - With Haiku 5.5, steer reaches the next request in a messages[] system entry;
 *   aimock's normalized messages omit it. Raw input still contains the marker
 *   before the same turn ends, and the native user echo keeps the input UUID.
 * - Concrete Haiku 4.5 stays effort-less and puts the steer in a user entry.
 * See runtime-version-checks/2026-10-07.md for the compatibility findings.
 */
/* oxlint-disable eslint/no-await-in-loop -- Run each model and probe sequentially to keep the native evidence ordered. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { awaitTurnEnd, claudeRuntime } from "../packages/oar/src/index.js";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/index.js";
import { asRecord, asRecordList, parseJson } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../sea-trial/harness/aimock.js";

const command = process.env.OAR_CLAUDE_BIN;
assert.ok(command !== undefined, "set OAR_CLAUDE_BIN");
const cwd = await mkdtemp(path.join(tmpdir(), "oar-claude-compatibility-"));
const overlay = { CLAUDE_CONFIG_DIR: cwd, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
async function effort(model: string): Promise<unknown> {
  const env = await startClaudeAimock(undefined, { captureRaw: true });
  const child = spawnLineProcess(command ?? "claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", model, "--effort", "low"], { cwd, env: { ...process.env, ...env.env, ...overlay, CLAUDECODE: undefined } });
  const settings = Promise.withResolvers<unknown>();
  const done = Promise.withResolvers<void>();
  const timer = setTimeout(() => { child.kill(); done.reject(new Error("effort probe timeout")); settings.reject(new Error("settings timeout")); }, 20_000);
  child.onLine((line) => {
    const msg = asRecord(parseJson(line));
    if (msg?.type === "control_response" && asRecord(msg.response)?.request_id === "settings") { settings.resolve(asRecord(asRecord(msg.response)?.response)?.applied); }
    if (msg?.type === "result") { done.resolve(); }
  });
  try {
    await child.spawned;
    child.write(`${JSON.stringify({ type: "control_request", request_id: "settings", request: { subtype: "get_settings" } })}\n`);
    const applied = await settings.promise;
    child.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`);
    await done.promise;
    return { selector: model, applied, requests: env.raw.filter((entry) => entry.path.includes("/v1/messages")).map((entry) => { const body = asRecord(entry.body); return { model: body?.model, effort: asRecord(body?.output_config)?.effort ?? null, thinking: body?.thinking ?? null }; }) };
  } finally { clearTimeout(timer); child.kill(); await child.exited; await env.stop(); }
}

async function steer(model: string): Promise<unknown> {
  const marker = "input-identity-probe";
  const provider: boolean[] = [];
  const env = await startClaudeAimock((mock) => {
    mock.onMessage(/[\s\S]*/u, (request: { messages?: unknown }) => {
      provider.push(JSON.stringify(request.messages).includes(marker));
      return provider.length === 1 ? { toolCalls: [{ name: "Bash", arguments: JSON.stringify({ command: 'node -e "setTimeout(()=>console.log(123),500)"' }) }] } : { content: "done" };
    });
  }, { captureRaw: true });
  const runtime = claudeRuntime;
  const installation = await runtime.installation();
  assert.ok(installation.kind === "available");
  const session = await runtime.session(installation, { cwd, model, env: { ...env.env, ...overlay } });
  const steerNow = session.steer?.bind(session) ?? assert.fail("claude has no steer");
  let sent = false;
  const timeline: unknown[] = [];
  session.events((event) => {
    timeline.push({ kind: event.kind, seq: event.seq, marker: JSON.stringify(event).includes(marker) });
    if (!sent && event.kind === "tool_call_started") { sent = true; void steerNow(marker, { inputId: randomUUID() }); }
  });
  const timer = setTimeout(() => { void session.dispose(); }, 20_000);
  try {
    const prompt = await session.prompt("run a tool");
    const outcome = await awaitTurnEnd(session, prompt.request.seq);
    const atTurnEnd = [...provider];
    // Distinguish delivery before this turn ends from a possible later turn.
    await delay(1500);
    return { model, outcome, atTurnEnd, provider, requests: env.raw.filter((entry) => entry.path.includes("/v1/messages")).map((entry) => {
      const body = asRecord(entry.body); return { model: body?.model, marker: JSON.stringify(body?.messages).includes(marker), markerRoles: asRecordList(body?.messages).filter((message) => JSON.stringify(message).includes(marker)).map((message) => message.role) };
    }), timeline };
  } finally { clearTimeout(timer); await session.dispose(); await env.stop(); }
}
try {
  for (const model of ["haiku", "claude-haiku-4-5-20251001"]) {
    console.log(JSON.stringify({ kind: "effort", report: await effort(model) }));
    console.log(JSON.stringify({ kind: "steer", report: await steer(model) }));
  }
} finally { await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
