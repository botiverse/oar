/* oxlint-disable max-statements, max-lines-per-function -- Assert native ordering, control ownership and public folds together. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { awaitIdle, awaitTurnEnd, promptAndWait, turnEndAfter } from "../../packages/oar/src/observe/turns.js";
import { statusOf } from "../../packages/oar/src/observe/agent-status.js";
import { initialSessionView, reduceSessionView, viewOf } from "../../packages/oar/src/observe/session-view.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.292" } as const;
const fixture = (suffix: string) => readFileSync(new URL(`../replay/fixtures/claude-workflow-prompt-collision.${suffix}.jsonl`, import.meta.url), "utf8")
  .trim().split("\n").map((line) => asRecord(parseJson(line))).filter((row) => row !== null);
const layout = (view: ReturnType<typeof viewOf>) => view.messages.map((message) => message.kind === "input"
    ? { kind: message.kind, id: message.id, input: message.input.input, state: message.input.state }
    : message);
const firstId = "6f1c2d3e-0001-4a5b-8c7d-000000000001";
const secondId = "6f1c2d3e-0002-4a5b-8c7d-000000000002";
const firstText = "RUN-WORKFLOW-FIXTURE: run the two-phase workflow.";
const secondText = "HOST-PROMPT: say host-answer";

test("recorded notification collision: the queued prompt owns only its started → result span", async () => {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  let live = initialSessionView();
  session.rawEvents((record) => { live = reduceSessionView(live, record); });
  const frames = fixture("raw");
  let projection = claudePrompted(initialClaudeProjection, firstId);
  await session.prompt(firstText, { inputId: firstId });
  let run: ReturnType<typeof promptAndWait> | undefined = undefined;

  let secondSeq = -1;
  try {
    for (const [index, message] of frames.entries()) {
      const next = foldClaudeStdout(projection, message);
      projection = next.state;
      child.emit(`${JSON.stringify(message)}\n`);
      const recorded = session.records().at(-1);
      expect(recorded?.kind === "frame" ? recorded.body.events : null).toEqual(next.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []));
      expect(session.status()).toEqual(statusOf(session.records(), session.id));
      expect(live).toEqual(viewOf(session.records()));
      if (message.subtype === "task_notification") {
        projection = claudePrompted(projection, secondId);
        run = promptAndWait(session, secondText, { inputId: secondId });
        // Install the consumer after its accepted control promise settles.
        // oxlint-disable-next-line no-await-in-loop
        await vi.waitFor(() => { expect(session.records().at(-1)?.kind).toBe("response"); });
        const request = session.records().findLast((record) => record.kind === "request" && record.body.kind === "prompt");
        assert.ok(request?.kind === "request"); secondSeq = request.seq;
      }
      if (index === 54) {
        expect(live.pendingInputs).toHaveLength(0);
        expect(live.messages.filter((item) => item.kind === "turn")).toHaveLength(2);
        expect(session.status().value).toMatchObject({ kind: "running", inputId: secondId, phase: "waiting_model" });
      }
      if (index === 55) {
        expect(session.status().value).toMatchObject({ kind: "running" });
        expect(session.status().value).not.toHaveProperty("requestId");
        expect(live.pendingInputs.map((input) => input.inputId)).toContain(secondId);
      }
      if (index === 66) {

        expect(turnEndAfter(session.records(), secondSeq, session.id, secondId)).toBeNull();
        expect(live.pendingInputs.map((input) => input.inputId)).toContain(secondId);
        // The accepted prompt is still owned, so another prompt cannot overtake it.
        // oxlint-disable-next-line no-await-in-loop
        expect(await session.prompt("too soon")).toMatchObject({ kind: "rejected", code: "busy" });
      }
      if (index === 67) {
        expect(session.status().value).toMatchObject({ kind: "running", inputId: secondId });
        expect(live.pendingInputs).toHaveLength(0);
      }
    }
    assert.ok(run !== undefined);
    expect(await run).toMatchObject({ kind: "ended", text: "host-answer", outcome: { kind: "completed" } });
    const native = session.records().flatMap((record) => record.kind === "frame" ? [record.body.native] : []);
    expect(native).toEqual(frames);
    expect(child.written.slice(0, 2).map((line) => asRecord(parseJson(line)))).toEqual(fixture("stdin"));
    const turns = live.messages.filter((message) => message.kind === "turn");
    expect(turns).toHaveLength(3);
    expect(turns[1]?.openedBy).toBeUndefined();
    expect(turns[2]?.openedBy).toBeDefined();
    const hostInput = live.messages.findIndex((message) => message.kind === "input" && message.input.inputId === secondId);
    assert.ok(turns[1] !== undefined);
    expect(hostInput).toBeGreaterThan(live.messages.indexOf(turns[1]));
    expect(await awaitTurnEnd(session, secondSeq, secondId)).toEqual({ kind: "completed" });
  } finally { await session.dispose(); }
});

test("queued then started preserves the prompt's visible status and layout until its result", async () => {
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  const request = await session.prompt("hello", { inputId: firstId });
  const before = viewOf(session.records());

  let idle = false;
  try {
    child.emit(`${JSON.stringify({ type: "command_lifecycle", command_uuid: firstId, state: "queued" })}\n`);
    const waiting = (async () => { const outcome = await awaitIdle(session); idle = true; return outcome; })();
    await Promise.resolve();
    expect(idle).toBe(false);
    for (const state of ["queued", "started"]) {
      if (state === "started") { child.emit(`${JSON.stringify({ type: "command_lifecycle", command_uuid: firstId, state })}\n`); }
      const view = viewOf(session.records());
      expect(view.status).toMatchObject({ kind: "running", sinceSeq: request.seq, requestId: request.request.id, inputId: firstId, phase: "waiting_model" });
      expect(layout(view)).toEqual(layout(before));
      expect(view.pendingInputs).toEqual(before.pendingInputs);
      expect(view.openTurn).toBe(before.openTurn);
    }
    child.emit(`${JSON.stringify({ type: "result", is_error: false })}\n`);
    expect(await waiting).toEqual({ kind: "completed" });
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); }
});

test.each(["queued", "intervening", "after-intervening"])("awaitIdle from %s waits for the owned input's result", async (at) => {
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  await session.prompt("hello", { inputId: firstId });
  const emit = (message: unknown): void => { child.emit(`${JSON.stringify(message)}\n`); };
  let settled = false;
  const tracker: { waiting?: ReturnType<typeof awaitIdle> } = {};
  const wait = (): void => { tracker.waiting = (async () => { const outcome = await awaitIdle(session); settled = true; return outcome; })(); };
  try {
    emit({ type: "command_lifecycle", command_uuid: firstId, state: "queued" });
    if (at === "queued") { wait(); }
    emit({ type: "system", subtype: "init" });
    if (at === "intervening") { wait(); }
    emit({ type: "result", is_error: true, result: "notification failed" });
    if (at === "after-intervening") { wait(); }
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    expect(session.status().value).toMatchObject({ kind: "running", inputId: firstId, phase: "waiting_model" });
    emit({ type: "command_lifecycle", command_uuid: firstId, state: "started" });
    emit({ type: "result", is_error: false });
    assert.ok(tracker.waiting !== undefined);
    expect(await tracker.waiting).toEqual({ kind: "completed" });
  } finally { await session.dispose(); }
});

test("recorded steer lifecycle is native-only, even when started follows its replayed input", async () => {
  const frames = readFileSync(new URL("../replay/fixtures/claude-steer-lifecycle.raw.jsonl", import.meta.url), "utf8")
    .trim().split("\n").map((line) => asRecord(parseJson(line))).filter((row) => row !== null);
  const promptId = String(frames[0]?.command_uuid);
  const steerId = String(frames[16]?.command_uuid);
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  await session.prompt("run Bash", { inputId: promptId });
  try {
    for (const [index, message] of frames.entries()) {
      if (index === 16) {
        assert.ok(session.steer !== undefined);
        // oxlint-disable-next-line no-await-in-loop
        expect(await session.steer("follow up", { inputId: steerId })).toMatchObject({ kind: "accepted" });
      }
      child.emit(`${JSON.stringify(message)}\n`);
      if (message.command_uuid === steerId) {
        expect(session.records().at(-1)).toMatchObject({ body: { native: message, events: [] } });
        expect(session.status().value).toMatchObject({ kind: "running", inputId: promptId });
      }
    }
    const events = session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []);
    expect(events.filter((event) => event.kind === "input_queued")).toEqual([{ kind: "input_queued", inputId: promptId }]);
    expect(events.filter((event) => event.kind === "turn_active")).toEqual([{ kind: "turn_active", inputId: promptId }]);
    expect(events.filter((event) => event.kind === "turn_ended")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "user_message" && event.inputId === steerId)).toHaveLength(1);
  } finally { await session.dispose(); }
});

test.each(["idle", "held"])("a %s queue input is registered when written and survives a notification result", async (mode) => {
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  await session.prompt(firstText, { inputId: firstId });
  try {
    for (const [index, message] of fixture("raw").entries()) {
      if (mode === "held" && index === 10) {
        // oxlint-disable-next-line no-await-in-loop
        await session.queue(secondText, { inputId: secondId });
        expect(child.written).toHaveLength(1);
      }
      child.emit(`${JSON.stringify(message)}\n`);
      if (mode === "idle" && index === 52) {
        // oxlint-disable-next-line no-await-in-loop
        await session.queue(secondText, { inputId: secondId });
      }
      if (index === 66) {
        expect(viewOf(session.records()).pendingInputs.map((input) => input.inputId)).toContain(secondId);
        // oxlint-disable-next-line no-await-in-loop
        expect(await session.prompt("cannot overtake")).toMatchObject({ kind: "rejected", code: "busy" });
      }
    }
    const events = session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []);
    expect(events.filter((event) => event.kind === "input_queued").map((event) => event.inputId)).toEqual([firstId, secondId]);
    expect(events.filter((event) => event.kind === "turn_active")).toEqual([
      { kind: "turn_active", inputId: firstId }, { kind: "turn_active" }, { kind: "turn_active", inputId: secondId },
    ]);
    expect(viewOf(session.records()).pendingInputs).toHaveLength(0);
    expect(child.written.slice(0, 2).map((line) => asRecord(parseJson(line)))).toEqual(fixture("stdin"));
  } finally { await session.dispose(); }
});

test.each([true, false])("promptAndWait supplies an id and falls back without queue evidence: lifecycle=%s", async (lifecycle) => {
  const child = fakeLineProcess((text, process) => {
    const input = asRecord(parseJson(text));
    if (input?.type !== "user") { return; }
    expect(input.uuid).toMatch(/^[0-9a-f-]{36}$/u);
    if (lifecycle) { process.emit(`${JSON.stringify({ type: "command_lifecycle", command_uuid: input.uuid, state: "queued" })}\n`); }
    process.emit(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
    process.emit(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "notification" }] } })}\n`);
    process.emit(`${JSON.stringify({ type: "result", is_error: false })}\n`);
    if (lifecycle) { process.emit(`${JSON.stringify({ type: "command_lifecycle", command_uuid: input.uuid, state: "started" })}\n`); }
    process.emit(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
    process.emit(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "own" }] } })}\n`);
    process.emit(`${JSON.stringify({ type: "result", is_error: false })}\n`);
  });
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  try {
    const result = await promptAndWait(session, "hello");
    expect(result).toMatchObject({ kind: "ended", text: lifecycle ? "own" : "notification" });
    expect(await awaitTurnEnd(session, result.result.seq)).toEqual({ kind: "completed" });
  } finally { await session.dispose(); }
});

test("unrelated lifecycle ids keep the existing init/result behavior", async () => {
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  await session.prompt("legacy");
  try {
    for (const message of [
      { type: "command_lifecycle", state: "queued", command_uuid: "unrelated" },
      { type: "command_lifecycle", state: "started", command_uuid: "unrelated" },
      { type: "system", subtype: "init" },
    ]) { child.emit(`${JSON.stringify(message)}\n`); }
    expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events : [])).toEqual([]);
    expect(session.status().value.kind).toBe("running");
  } finally { await session.dispose(); }
});
