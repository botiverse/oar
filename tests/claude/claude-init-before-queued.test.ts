/* oxlint-disable max-statements, max-lines-per-function -- Pin the recorded ordering through projection, live control and replay together. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { awaitTurnEnd, promptAndWait, turnEndAfter } from "../../packages/oar/src/observe/turns.js";
import { statusOf } from "../../packages/oar/src/observe/agent-status.js";
import { initialSessionView, reduceSessionView, viewOf, type ViewTurn } from "../../packages/oar/src/observe/session-view.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.292" } as const;
// Lookout's 2026-10-10 Claude 2.1.292 + aimock recordings (issue #326).
// The second write followed task_notification by 20 ms (init first) or 0 ms (queued first).
// Account-free; fixture home, cwd and socket paths are placeholders.
const fixture = (order: string, suffix: string) => readFileSync(new URL(`../replay/fixtures/claude-prompt-after-bg-task-${order}.${suffix}.jsonl`, import.meta.url), "utf8")
  .trim().split("\n").map((line) => asRecord(parseJson(line))).filter((row) => row !== null);
const firstId = "6f1c2d3e-0001-4a5b-8c7d-000000000001";
const secondId = "6f1c2d3e-0002-4a5b-8c7d-000000000002";
const turnText = (turn: ViewTurn) => turn.sections.flatMap((section) => section.parts.flatMap((part) => part.kind === "text" ? [part.text] : [])).join("");

test.each([
  { order: "init-first", writeAfter: 31 },
  { order: "queued-first", writeAfter: 31 },
  { order: "queued-first", writeAfter: 29 }, // The background task is still running when the host writes.
])("recorded $order, write after frame $writeAfter: notification and prompt have separate turns", async ({ order, writeAfter }) => {
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  let live = initialSessionView();
  session.rawEvents((record) => { live = reduceSessionView(live, record); });
  let projection = claudePrompted(initialClaudeProjection, firstId);
  let run: ReturnType<typeof promptAndWait> | undefined = undefined;
  let promptSeq = -1;
  await session.prompt("START-BG: start the background command", { inputId: firstId });
  const frames = fixture(order, "raw");
  try {
    for (const [index, message] of frames.entries()) {
      const next = foldClaudeStdout(projection, message); projection = next.state;
      child.emit(`${JSON.stringify(message)}\n`);
      const record = session.records().at(-1);
      assert.ok(record?.kind === "frame");
      expect(record.body.events).toEqual(next.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []));
      expect(live).toEqual(viewOf(session.records()));
      expect(session.status()).toEqual(statusOf(session.records(), session.id));
      if (index === writeAfter) {
        projection = claudePrompted(projection, secondId);
        run = promptAndWait(session, "What is 2+2?", { inputId: secondId });
        // oxlint-disable-next-line no-await-in-loop
        await vi.waitFor(() => { expect(session.records().at(-1)?.kind).toBe("response"); });
        const request = session.records().findLast((item) => item.kind === "request" && item.body.kind === "prompt");
        assert.ok(request?.kind === "request"); promptSeq = request.seq;
      }
      if (message.command_uuid === secondId && message.state === "queued" && order === "init-first") {
        expect(record.body.events).toEqual([{ kind: "input_queued", inputId: secondId }, { kind: "turn_active" }]);
        expect(live.pendingInputs.map((input) => input.inputId)).toEqual([secondId]);
        expect(session.status().value).toMatchObject({ kind: "running" });
        expect(session.status().value).not.toHaveProperty("inputId");
      }
      if (index === 45) {
        expect(turnEndAfter(session.records(), promptSeq, session.id, secondId)).toBeNull();
        expect(session.status().value).toMatchObject({ kind: "running", inputId: secondId, phase: "waiting_model" });
        expect(live.pendingInputs.map((input) => input.inputId)).toEqual([secondId]);
      }
    }
    assert.ok(run !== undefined);
    expect(await run).toMatchObject({ kind: "ended", text: "4", outcome: { kind: "completed" } });
    expect(await awaitTurnEnd(session, promptSeq, secondId)).toEqual({ kind: "completed" });
    expect(session.status().value.kind).toBe("idle");
    expect(live.pendingInputs).toHaveLength(0);
    const turns = live.messages.filter((message) => message.kind === "turn");
    expect(turns).toHaveLength(3);
    expect(turns[1]?.openedBy).toBeUndefined();
    expect(turns[2]?.openedBy).toBeDefined();
    expect(turns.slice(1).map((turn) => turnText(turn))).toEqual(["The background command finished: bg-done.", "4"]);
    assert.ok(turns[1] !== undefined && turns[2] !== undefined);
    const inputIndex = live.messages.findIndex((message) => message.kind === "input" && message.input.inputId === secondId);
    expect(inputIndex).toBeGreaterThan(live.messages.indexOf(turns[1]));
    expect(inputIndex).toBeLessThan(live.messages.indexOf(turns[2]));
    const events = session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []);
    expect(events.filter((event) => event.kind === "turn_active")).toEqual([
      { kind: "turn_active", inputId: firstId }, { kind: "turn_active" }, { kind: "turn_active", inputId: secondId },
    ]);
    const saved = JSON.stringify(session.records());
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- JSON retention of typed records is the host's replay boundary under test.
    const restored: ReturnType<typeof session.records> = JSON.parse(saved);
    expect(viewOf(restored)).toEqual(live);
    expect(session.records().flatMap((record) => record.kind === "frame" ? [record.body.native] : [])).toEqual(frames);
    expect(child.written.map((line) => asRecord(parseJson(line)))).toEqual(fixture(order, "stdin"));
  } finally { await session.dispose(); }
});

const init = { type: "system", subtype: "init" };
const queued = { type: "command_lifecycle", command_uuid: firstId, state: "queued" };
const started = { ...queued, state: "started" };
const result = { type: "result", is_error: false };

test.each([
  { name: "repeated init and queued", before: [], after: [init, init, queued, queued, init], prompted: true, active: [{}] },
  { name: "started already owns the init", before: [], after: [started, init, queued], prompted: true, active: [{ inputId: firstId }] },
  { name: "started claims the init before queued", before: [], after: [init, started, queued], prompted: true, active: [{ inputId: firstId }] },
  { name: "a child init is not root activity", before: [], after: [{ ...init, parent_tool_use_id: "child" }, queued], prompted: true, active: [] },
  { name: "a child result does not end the root init", before: [], after: [init, { ...result, parent_tool_use_id: "child" }, queued], prompted: true, active: [{}] },
  { name: "unrelated queue receipts do not consume the init", before: [], after: [init, { ...queued, command_uuid: secondId }, queued], prompted: true, active: [{}] },
  { name: "the init predates this write", before: [init], after: [queued, init], prompted: true, active: [] },
  { name: "the init's turn already ended", before: [], after: [init, result, queued], prompted: true, active: [] },
  { name: "an idle queue already reported a spontaneous turn", before: [], after: [init, queued, init], prompted: false, active: [{}] },
])("$name does not invent or repeat spontaneous activity", ({ before, after, prompted, active }) => {
  let state = initialClaudeProjection;
  for (const message of before) { ({ state } = foldClaudeStdout(state, message)); }
  state = claudePrompted(state, firstId, prompted);
  const events = after.flatMap((message: JsonRecord) => {
    const folded = foldClaudeStdout(state, message); ({ state } = folded);
    return folded.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []);
  });
  expect(events.filter((event) => event.kind === "turn_active")).toEqual(active.map((identity) => ({ kind: "turn_active", ...identity })));
});

test("cancelling the pending prompt leaves the recovered notification turn busy", async () => {
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  const emit = (message: JsonRecord): void => { child.emit(`${JSON.stringify(message)}\n`); };
  try {
    const prompt = await session.prompt("What is 2+2?", { inputId: firstId });
    emit(init); emit(queued); emit({ ...queued, state: "cancelled" });
    expect(await awaitTurnEnd(session, prompt.seq, firstId)).toEqual({ kind: "aborted" });
    expect(session.status().value).toMatchObject({ kind: "running" });
    expect(session.status().value).not.toHaveProperty("inputId");
    expect(await session.prompt("too soon")).toMatchObject({ kind: "rejected", code: "busy" });
    emit(result);
    expect(session.status().value.kind).toBe("idle");
    expect(await session.prompt("next")).toMatchObject({ kind: "accepted" });
  } finally { await session.dispose(); }
});
