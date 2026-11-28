/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- Each test exercises one Bottega turn-ordering or shutdown boundary with a scripted serve fixture. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RawEvent, RuntimeEventBody, Session } from "../../packages/oar/src/contracts/session.js";
import { bottegaRuntime } from "../../packages/oar/src/runtimes/bottega/index.js";

const sessions: Session[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(sessions.splice(0).map(async (session) => { await session.dispose(); }));
  await Promise.all(tempDirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); }));
});

const eventsOf = (records: readonly RawEvent[]): RuntimeEventBody[] =>
  records.flatMap((record) => record.kind === "frame" ? record.body.events : []);

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  // oxlint-disable-next-line no-await-in-loop -- Polling a stream written by a child process.
  while (!check() && Date.now() < deadline) { await delay(10); }
  assert.ok(check(), "the awaited state was not reached");
}

async function writeScriptedBottega(source: string): Promise<{ readonly dir: string; readonly command: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-bottega-race-"));
  tempDirs.push(dir);
  const command = path.join(dir, "scripted-bottega.mjs");
  await writeFile(command, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(command, 0o755);
  return { dir, command };
}

describe.skipIf(process.platform === "win32")("bottega queue and abort-fallback races", () => {
  test("a held queue input rejected busy during a steer-after-abort turn is re-queued without tight-looping and runs after Turn 2 ends", async () => {
    const fixture = await writeScriptedBottega(`
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
send({ type: "ready", protocol: 1, version: "0.3.1" });
let pendingSteer = null;
let turn = null;
let promptCallsForQueued = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.method === "open") {
    send({ type: "response", id: msg.id, result: { sessionId: "race-1", provider: "fake", model: "m1", thinking: "medium" } });
  } else if (msg.method === "prompt") {
    if (msg.text === "queued-after-steer") { promptCallsForQueued += 1; }
    if (turn !== null || pendingSteer !== null) {
      send({ type: "response", id: msg.id, error: { code: "busy", message: "busy" } });
      continue;
    }
    send({ type: "response", id: msg.id, result: { as: "line" } });
    turn = { inputId: msg.inputId };
    send({ type: "said", id: "u-" + msg.id, step: 1, who: "user", text: msg.text, ...(msg.inputId ? { inputId: msg.inputId } : {}) });
    send({ type: "turn_started", step: 1, ...(msg.inputId ? { inputId: msg.inputId } : {}) });
    if (msg.text === "queued-after-steer") {
      send({ type: "said", id: "a-" + msg.id, step: 1, who: "agent", text: "delivered:" + String(promptCallsForQueued) });
      turn = null;
      send({ type: "turn_ended", step: 1, outcome: "completed", inputIds: msg.inputId ? [msg.inputId] : [] });
    }
  } else if (msg.method === "steer") {
    pendingSteer = { text: msg.text, inputId: msg.inputId };
    send({ type: "response", id: msg.id, result: { as: "line" } });
  } else if (msg.method === "cancel") {
    send({ type: "response", id: msg.id, result: {} });
    const endedId = turn?.inputId;
    turn = null;
    send({ type: "turn_ended", step: 1, outcome: "aborted", inputIds: endedId ? [endedId] : [] });
    // Mirror real bottega: start Turn 2 for the pre-abort steer after a short gap while busy is already true.
    setTimeout(() => {
      const steer = pendingSteer;
      pendingSteer = null;
      turn = { inputId: steer.inputId };
      send({ type: "said", id: "u-steer", step: 2, who: "user", text: steer.text, inputId: steer.inputId });
      send({ type: "turn_started", step: 2, inputId: steer.inputId });
      setTimeout(() => {
        turn = null;
        send({ type: "said", id: "a-steer", step: 2, who: "agent", text: "steer-done" });
        send({ type: "turn_ended", step: 2, outcome: "completed", inputIds: [steer.inputId] });
      }, 60);
    }, 40);
  } else if (msg.method === "dispose") {
    send({ type: "response", id: msg.id, result: {} });
    break;
  }
}
`);
    const session = await bottegaRuntime.session(
      { kind: "available", via: "executable", command: fixture.command },
      { cwd: fixture.dir },
    );
    sessions.push(session);
    assert.ok(session.steer !== undefined);

    const steerId = "11111111-0000-4000-8000-000000000001";
    const queueId = "22222222-0000-4000-8000-000000000002";
    await session.prompt("turn-1");
    await until(() => eventsOf(session.records()).some((event) => event.kind === "turn_active"));
    const steered = await session.steer("steer-note", { inputId: steerId });
    expect(steered.kind).toBe("accepted");
    const queued = await session.queue("queued-after-steer", { inputId: queueId });
    expect(queued.response.body).toEqual({ kind: "accepted", queued: "adapter" });
    const aborted = await session.abort();
    expect(aborted.kind).toBe("accepted");

    await until(() => eventsOf(session.records()).filter((event) => event.kind === "turn_ended").length === 3);
    const events = eventsOf(session.records());
    const queuedPrompts = session.records().filter((record) => record.kind === "request" && record.body.kind === "prompt" && record.body.input === "queued-after-steer");
    // Exactly one busy collision before Turn 2 settles, then one successful delivery after Turn 2 ends (no tight-loop spin).
    expect(queuedPrompts).toHaveLength(2);
    expect(events.filter((event) => event.kind === "input_dropped")).toEqual([]);
    expect(events.find((event) => event.kind === "user_message" && event.input === "queued-after-steer")).toMatchObject({ inputId: queueId });
    expect(events.findLast((event) => event.kind === "turn_ended")).toMatchObject({ outcome: { kind: "completed" }, inputIds: [queueId] });
    expect(session.status().value.kind).toBe("idle");
  });

  test("abort fallback is cleared when an in-flight prompt rejects without starting a turn", async () => {
    const fixture = await writeScriptedBottega(`
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
send({ type: "ready", protocol: 1, version: "0.3.1" });
let promptId = null;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.method === "open") {
    send({ type: "response", id: msg.id, result: { sessionId: "fb-1", provider: "fake", model: "m1", thinking: "medium" } });
  } else if (msg.method === "prompt") {
    promptId = msg.id;
  } else if (msg.method === "cancel") {
    send({ type: "response", id: msg.id, result: {} });
    if (promptId !== null) {
      send({ type: "response", id: promptId, error: { code: "invalid_request", message: "rejected after cancel" } });
      promptId = null;
    }
  } else if (msg.method === "dispose") {
    send({ type: "response", id: msg.id, result: {} });
    break;
  }
}
`);
    const session = await bottegaRuntime.session(
      { kind: "available", via: "executable", command: fixture.command },
      { cwd: fixture.dir },
    );
    sessions.push(session);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const promptAttempt = session.prompt("hello");
    const abortAttempt = session.abort();
    const [promptResult, abortResult] = await Promise.all([promptAttempt, abortAttempt]);
    expect(promptResult.response.body).toMatchObject({ kind: "rejected", code: "runtime_refused" });
    expect(abortResult.response.body).toEqual({ kind: "accepted", native: {} });

    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    await delay(100);
    expect(session.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(false);
    expect(session.status().value.kind).toBe("idle");
  });
});
