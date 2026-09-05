/**
 * LIVE RESUME + MODEL SWITCH (codex) — resuming a thread id with a different
 * model switches the model, and the effective model is readable from the
 * thread/resume response instead of being trusted from the request.
 *
 * Method, two layers:
 * 1. Adapter path: a session under model X learns a codeword (this also
 *    writes the rollout; an unused thread cannot be resumed).
 * 2. Raw app-server client: fresh app-server, thread/resume {threadId,
 *    model: Y}, read response.model; then thread/resume again in that SAME
 *    process with X to observe what a loaded thread does with an override.
 * 3. Adapter path: runtime.session({resume, model: Y}) must resolve (the
 *    adapter rejects when the response model differs from the request), keep
 *    the id, and still recall the codeword.
 *
 * Run: pnpm tsx experiments/session-resume-model.ts [X] [Y]
 * Defaults X=gpt-5.4-mini Y=gpt-5.5. Burns tokens for two short turns.
 *
 * Source pin: codex tag rust-v0.153.4 (3d2ee51c) —
 * app-server-protocol/src/protocol/v2/thread.rs: ThreadResumeParams.model,
 * ThreadResumeResponse.model (the active model);
 * app-server/src/request_processors/thread_processor.rs
 * resume_running_thread: an already-loaded thread with override mismatches is
 * torn down and reloaded cold only when idle, unsubscribed and not running;
 * otherwise the overrides are dropped with a warn log
 * ("thread/resume overrides ignored for loaded thread") and the response
 * reports the OLD model. That is the silent-keep path the adapter guards.
 *
 * ── OBSERVED 2026-09-05, codex-cli 0.153.4, linux x64 ──
 *
 * X=gpt-5.4-mini, Y=gpt-5.5. Adapter session under X replied "ok"; a fresh
 * app-server's thread/resume {model: Y} answered model=gpt-5.5 (applied);
 * the adapter resume under Y kept the id and replied "PLUM-42".
 *
 * The silent-keep path is real and reachable from a single client: a second
 * thread/resume {model: X} on the SAME connection answered model=gpt-5.5, i.e.
 * the override was dropped and the response named the model still active.
 * Reason (thread_processor.rs, thread/resume handler): resuming auto-attaches
 * the calling connection as a thread listener via ensure_conversation_listener
 * → try_ensure_connection_subscribed, so the loaded thread has a subscriber
 * and resume_running_thread takes the "overrides ignored" branch. Only the
 * response model tells the caller; the request params say Y while X runs.
 * oar's adapter compares response.model with options.model and rejects on
 * mismatch (tests/codex/codex-session-resume-model.test.ts).
 *
 * A thread with no turn yet cannot be resumed: "no rollout found for thread
 * id …" (rollout is created on the first turn).
 */
import assert from "node:assert/strict";
import { runtimes, type SessionEvent } from "../packages/oar/src/index.js";
import { startAppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

const modelX = process.argv[2] ?? "gpt-5.4-mini";
const modelY = process.argv[3] ?? "gpt-5.5";
assert.notEqual(modelX, modelY, "X and Y must differ");

const runtime = runtimes.require("codex");
const probed = await runtime.installation?.();
if (probed?.kind !== "available" || probed.via !== "executable") {
  throw new Error("codex is not available as an executable");
}
const installation = probed;

async function handshake(): Promise<ReturnType<typeof startAppServerClient>> {
  const client = startAppServerClient(installation.command);
  await client.request("initialize", {
    clientInfo: { name: "oar-experiment", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized", {});
  return client;
}

function threadIdOf(response: Record<string, unknown>): string {
  const id = asRecord(response.thread)?.id;
  if (typeof id !== "string") {
    throw new TypeError("response carries no thread.id");
  }
  return id;
}

// ── Layer 1: raw wire, on the thread the adapter just taught ──
// (a thread without any turn has no rollout yet: thread/resume on it fails
// with "no rollout found", so the raw layer runs after the first adapter turn)
async function observeRawResume(threadId: string): Promise<void> {
  const client = await handshake();
  const resumed = await client.request("thread/resume", { threadId, cwd: process.cwd(), model: modelY, approvalPolicy: "never" });
  process.stdout.write(`thread/resume (cold, fresh app-server) model=${String(resumed.model)}\n`);
  assert.equal(threadIdOf(resumed), threadId, "resume keeps the thread id");
  assert.equal(resumed.model, modelY, "cold thread/resume applies the requested model");

  // Same process, thread now loaded (idle, no thread/subscribe from us).
  const reResumed = await client.request("thread/resume", { threadId, cwd: process.cwd(), model: modelX, approvalPolicy: "never" });
  process.stdout.write(`thread/resume (same app-server, loaded thread) model=${String(reResumed.model)}\n`);
  // The override is dropped: this connection became a subscriber on the first
  // resume, so codex keeps the loaded thread and reports the model it still
  // runs. This is the case the adapter's mismatch check exists for.
  assert.equal(reResumed.model, modelY, "loaded, subscribed thread keeps its model and says so");
  client.kill();
  await client.exited;
}

// ── Layers 1 and 3: adapter path with continuity ──
async function runTurn(
  sessionOptions: { cwd: string; model: string; resume?: string },
  prompt: string,
): Promise<{ id: string; text: string }> {
  const session = await runtime.session(installation, sessionOptions);
  const texts: string[] = [];
  session.subscribe((event: SessionEvent) => {
    if (event.kind === "text_delta") {
      texts.push(event.text);
    }
  });
  const result = session.prompt(prompt);
  if (result.kind !== "turn") {
    throw new Error("busy");
  }
  const outcome = await result.turn.outcome;
  if (outcome.kind !== "completed") {
    throw new Error(`turn ${outcome.kind}`);
  }
  await session.dispose();
  return { id: session.id, text: texts.join("") };
}

const taught = await runTurn({ cwd: process.cwd(), model: modelX }, "Remember this codeword: PLUM-42. Reply with exactly ok.");
process.stdout.write(`adapter: session under ${modelX} id=${taught.id} replied=${JSON.stringify(taught.text.slice(0, 30))}\n`);

await observeRawResume(taught.id);

// The adapter rejects when thread/resume reports a model other than modelY,
// so a resolved session here is itself the effective-model check.
const switched = await runTurn(
  { cwd: process.cwd(), model: modelY, resume: taught.id },
  "What was the codeword I told you earlier? Reply with exactly it.",
);
process.stdout.write(`adapter: resumed under ${modelY} id=${switched.id} replied=${JSON.stringify(switched.text.slice(0, 40))}\n`);
assert.equal(switched.id, taught.id, "resumed session keeps the id");
assert.ok(switched.text.includes("PLUM-42"), "transcript survives the model switch");

process.stdout.write("codex resume+model probe PASSED\n");
