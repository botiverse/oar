/* oxlint-disable max-statements -- Each regression follows one native result through controls and record folds. */
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { launchClaude } from "../../packages/oar/src/runtimes/claude/launch.js";
import { claudeAbortRequested, foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { promptAndWait, turnEndAfter } from "../../packages/oar/src/observe/turns.js";
import { initialSessionView, reduceSessionView, viewOf } from "../../packages/oar/src/observe/session-view.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "claude" } as const;
const outputSchema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
// Real Claude 2.1.296 + aimock, 2026-10-11; result frames only, session and message ids removed.
const resultFrame = (mode: string) => {
  const contents = readFileSync(new URL(`../replay/fixtures/claude-structured-output-${mode}.raw.jsonl`, import.meta.url), "utf8");
  return asRecord(parseJson(contents)) ?? {};
};
const outcomeOf = (frame: JsonRecord, aborted = false) => foldClaudeStdout(aborted ? claudeAbortRequested(initialClaudeProjection) : initialClaudeProjection, frame).commands
  .flatMap((command) => command.kind === "frame" ? command.body.events : []).find((event) => event.kind === "turn_ended")?.outcome;

test.each([undefined, "existing-session"])("schema is a native launch argument, including resume %s", async (resume) => {
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  await launchClaude("claude", "session", { cwd: "/work", outputSchema, ...(resume === undefined ? {} : { resume }), launchArgs: ["--verbose"], disallowedTools: ["Bash"] });
  const args: unknown = spawnLineProcess.mock.calls[0]?.[1];
  expect(args).toEqual(expect.arrayContaining(["--json-schema", JSON.stringify(outputSchema), "--disallowed-tools", "Bash"]));
  child.kill();
});

test.each([null, false, 0, "", { nested: [1, "two"] }])("native structured values pass through without truthiness or text parsing: %j", (value) => {
  expect(outcomeOf({ type: "result", is_error: false, result: "unrelated text", structured_output: value }))
    .toEqual({ kind: "completed", structuredOutput: value });
});

test("no structured field is inferred from JSON text or carried on failed/aborted outcomes", () => {
  const frame = { type: "result", result: '{"answer":4}', structured_output: { answer: 4 } };
  expect(outcomeOf({ type: "result", result: '{"answer":4}' })).toEqual({ kind: "completed" });
  expect(outcomeOf(frame, true)).toEqual({ kind: "aborted" });
  expect(outcomeOf({ ...frame, is_error: true, subtype: "error" })).not.toHaveProperty("structuredOutput");
  expect(outcomeOf(resultFrame("invalid"))).toMatchObject({ kind: "failed", failure: "unknown", reason: "error_max_structured_output_retries" });
});

test.each(["valid", "invalid"])("recorded %s result reaches live wait, status and JSON replay unchanged", async (mode) => {
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work", outputSchema });
  let live = initialSessionView();
  session.rawEvents((record) => { live = reduceSessionView(live, record); });
  try {
    const run = promptAndWait(session, "answer");
    await vi.waitFor(() => { expect(session.records().at(-1)?.kind).toBe("response"); });
    child.emit(`${JSON.stringify(resultFrame(mode))}\n`);
    const expected = outcomeOf(resultFrame(mode));
    expect(await run).toMatchObject({ kind: "ended", text: "", outcome: expected });
    expect(session.status().value).toMatchObject({ kind: "idle", lastTurnOutcome: expected });
    const turn = live.messages.find((message) => message.kind === "turn");
    expect(turn?.outcome).toEqual(expected);
    // oxlint-disable-next-line typescript/no-unsafe-assignment, unicorn/prefer-structured-clone -- JSON persistence, not in-memory cloning, is under test.
    const records: ReturnType<typeof session.records> = JSON.parse(JSON.stringify(session.records()));
    expect(viewOf(records)).toEqual(live);
    expect(turnEndAfter(records, -1, session.id)).toEqual(expected);
    expect(records.findLast((record) => record.kind === "frame")?.body.native).toEqual(resultFrame(mode));
  } finally { await session.dispose(); }
});

test("a child result cannot answer the root wait and the next turn cannot inherit a structured result", async () => {
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  try {
    const run = promptAndWait(session, "root");
    await vi.waitFor(() => { expect(session.records().at(-1)?.kind).toBe("response"); });
    child.emit(`${JSON.stringify({ ...resultFrame("valid"), parent_tool_use_id: "child" })}\n`);
    expect(turnEndAfter(session.records(), -1, session.id)).toBeNull();
    child.emit(`${JSON.stringify(resultFrame("valid"))}\n`);
    expect(await run).toMatchObject({ outcome: { kind: "completed", structuredOutput: { answer: 4 } } });
    const next = promptAndWait(session, "plain");
    await vi.waitFor(() => { expect(session.records().at(-1)?.kind).toBe("response"); });
    child.emit('{"type":"result","is_error":false}\n');
    expect(await next).toMatchObject({ outcome: { kind: "completed" } });
    expect(session.status().value).toEqual({ kind: "idle", lastTurnOutcome: { kind: "completed" } });
  } finally { await session.dispose(); }
});
