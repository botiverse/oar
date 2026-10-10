/* oxlint-disable max-statements, max-lines-per-function, no-await-in-loop -- Replay the recorded interleaving with writes at their original native boundaries. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.292" } as const;
const failure = { kind: "failed", failure: "invalid_request", reason: "claude ignored the input: its inputId was already used in this session" };
const fixture = (name: string, suffix: string) => readFileSync(new URL(`../replay/fixtures/claude-${name}.${suffix}.jsonl`, import.meta.url), "utf8")
  .trim().split("\n").map((line) => asRecord(parseJson(line))).filter((row) => row !== null);
function input(frame: JsonRecord | undefined): { text: string; inputId: string } {
  assert.ok(frame !== undefined && typeof frame.uuid === "string");
  const content = asRecord(frame.message)?.content;
  assert.ok(Array.isArray(content));
  return { inputId: frame.uuid, text: content.map((part: unknown) => asRecord(part)).map((part) => typeof part?.text === "string" ? part.text : "").join("") };
}
async function run(session: Session, frame: JsonRecord | undefined) {
  const { text, inputId } = input(frame);
  return promptAndWait(session, text, { inputId });
}

// Lookout's real Claude2.1.292 + aimock recordings; only local paths scrubbed further.
test("recorded dropped id reuse resolves as invalid_request without waiting for a nonexistent turn", async () => {
  const frames = fixture("duplicate-inputid-after-drop", "raw");
  const writes = fixture("duplicate-inputid-after-drop", "stdin");
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  const first = input(writes[0]); await session.prompt(first.text, { inputId: first.inputId });
  let cancelled: ReturnType<typeof run> | undefined = undefined;
  let retry: ReturnType<typeof run> | undefined = undefined;
  let abort: ReturnType<Session["abort"]> | undefined = undefined;
  try {
    for (const [index, native] of frames.entries()) {
      if (index === 57) { abort = session.abort(); }
      if (index === 61) { retry = run(session, writes[3]); await vi.waitFor(() => { expect(child.written).toHaveLength(4); }); }
      child.emit(`${JSON.stringify(native)}\n`);
      if (index === 52) { cancelled = run(session, writes[1]); await vi.waitFor(() => { expect(child.written).toHaveLength(2); }); }
    }
    expect(await cancelled).toMatchObject({ kind: "ended", outcome: { kind: "aborted" } });
    expect(await abort).toMatchObject({ kind: "accepted" });
    expect(await retry).toMatchObject({ kind: "ended", outcome: failure });
    expect(child.written.map((line) => asRecord(parseJson(line)))).toEqual(writes);
    expect(session.status().value.kind).toBe("idle");
    expect(viewOf(session.records()).messages.find((item) => item.kind === "input" && item.input.inputId === input(writes[1]).inputId)).toMatchObject({ input: { state: "dropped", reason: "runtime_refused" } });
    expect(await session.prompt("fresh identity")).toMatchObject({ kind: "accepted" });
    expect(child.killed()).toBe(false);
  } finally { await session.dispose(); }
});

test("recorded resume-id reuse has only replay/completed and never opens a turn", async () => {
  const frames = fixture("duplicate-inputid-after-resume", "raw");
  const child = fakeLineProcess((text, process) => {
    const request = asRecord(parseJson(text));
    if (request?.type === "control_request") {
      process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: {} } })}\n`);
    }
  });
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work", resume: "00000000-0000-4000-8000-000000000001" });
  try {
    const waiting = run(session, fixture("duplicate-inputid-after-resume", "stdin")[0]);
    await vi.waitFor(() => { expect(child.written.some((line) => asRecord(parseJson(line))?.type === "user")).toBe(true); });
    for (const native of frames) { child.emit(`${JSON.stringify(native)}\n`); }
    expect(await waiting).toMatchObject({ kind: "ended", outcome: failure });
    expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []).filter((event) => event.kind === "input_dropped")).toHaveLength(1);
    expect(session.status().value.kind).toBe("idle");
    expect(await session.prompt("fresh identity")).toMatchObject({ kind: "accepted" });
  } finally { await session.dispose(); }
});

test("recorded queued prompt folded into a notification at a tool boundary is delivered, not a duplicate", async () => {
  const frames = fixture("prompt-folded-into-notification", "raw");
  const writes = fixture("prompt-folded-into-notification", "stdin");
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  const first = input(writes[0]); await session.prompt(first.text, { inputId: first.inputId });
  let waiting: ReturnType<typeof run> | undefined = undefined;
  try {
    for (const [index, native] of frames.entries()) {
      child.emit(`${JSON.stringify(native)}\n`);
      if (index === 52) { waiting = run(session, writes[1]); await vi.waitFor(() => { expect(child.written).toHaveLength(2); }); }
    }
    const answer = await waiting;
    expect(answer).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    assert.ok(answer?.kind === "ended");
    expect(answer.text).toContain("notification handled");
    expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []).filter((event) => event.kind === "input_dropped")).toEqual([]);
    expect(child.written.map((line) => asRecord(parseJson(line)))).toEqual(writes);
    expect(session.status().value.kind).toBe("idle");
    expect(viewOf(session.records()).pendingInputs).toHaveLength(0);
  } finally { await session.dispose(); }
});
