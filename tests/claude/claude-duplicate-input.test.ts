import { afterEach, expect, test, vi } from "vitest";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); vi.useRealTimers(); });
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.292" } as const;
const inputId = "00000000-0000-4000-8000-000000000101";
const message = "claude ignored the input: its inputId was already used in this session";
const ignored = { kind: "failed", failure: "invalid_request", reason: message };
const replay = { type: "user", uuid: inputId, isReplay: true, message: { role: "user", content: [{ type: "text", text: "again" }] } };
const completed = { type: "command_lifecycle", command_uuid: inputId, state: "completed" };
const started = { type: "command_lifecycle", command_uuid: inputId, state: "started" };

function events(result: ReturnType<typeof foldClaudeStdout>) {
  return result.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []);
}

test.each([replay, completed])("an unstarted registered input ignored by claude is dropped: $type", (native) => {
  const next = foldClaudeStdout(claudePrompted(initialClaudeProjection, inputId), native);
  expect(events(next)).toContainEqual({ kind: "input_dropped", inputId, reason: "runtime_refused", failure: "invalid_request", message });
  expect(next.state.promptInputs.has(inputId)).toBe(false);
  expect(next.state.unstartedInputs.has(inputId)).toBe(false);
  expect(next.state.promptInputId).toBeNull();
  expect(next.state.pendingInputId).toBeNull();
  expect(next.state.turnActive).toBe(false);
});

test.each([replay, completed])("unregistered, child, queued and started input frames never imply a duplicate: $type", (native) => {
  const registered = claudePrompted(initialClaudeProjection, inputId);
  const active = foldClaudeStdout(registered, started).state;
  const queued = foldClaudeStdout(registered, { ...started, state: "queued" }).state;
  for (const [state, frame] of [[initialClaudeProjection, native], [queued, native], [active, native], [registered, { ...native, parent_tool_use_id: "child" }]] as const) {
    expect(events(foldClaudeStdout(state, frame)).filter((event) => event.kind === "input_dropped")).toEqual([]);
  }
});

// oxlint-disable-next-line eslint/max-statements -- Pin release of the owned slot and timeout together with the recorded native refusal.
test.each([replay, completed])("an ignored duplicate resolves both waits and frees the next prompt: $type", async (native) => {
  vi.useFakeTimers();
  const child = fakeLineProcess(); spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  try {
    const run = promptAndWait(session, "again", { inputId, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    const seq = session.records().find((record) => record.kind === "request" && record.body.kind === "prompt")?.seq;
    expect(seq).toBeDefined();
    const wait = awaitTurnEnd(session, seq ?? -1, inputId);
    child.emit(`${JSON.stringify(native)}\n`);
    expect(await run).toMatchObject({ kind: "ended", outcome: ignored, text: "" });
    expect(await wait).toEqual(ignored);
    expect(session.status().value.kind).toBe("idle");
    expect(viewOf(session.records()).messages.find((entry) => entry.kind === "input")).toMatchObject({ input: { state: "dropped", reason: "runtime_refused" } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.killed()).toBe(false);
    expect(child.written.map((line) => asRecord(parseJson(line))?.type)).toEqual(["user"]);
    expect(await session.prompt("new id")).toMatchObject({ kind: "accepted" });
  } finally { await session.dispose(); }
});
