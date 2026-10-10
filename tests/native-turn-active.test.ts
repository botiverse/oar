import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import type { FrameBody } from "../packages/oar/src/contracts/session.js";
import { statusOf } from "../packages/oar/src/observe/agent-status.js";
import { eventsOf } from "../packages/oar/src/observe/events.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection } from "../packages/oar/src/runtimes/claude/projection.js";
import { foldCodexNotification, initialCodexProjection } from "../packages/oar/src/runtimes/codex/projection.js";
import { foldPiEvent, initialPiProjection } from "../packages/oar/src/runtimes/pi/projection.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";

function nativeStart(runtime: string): FrameBody {
  if (runtime === "claude") {
    const [command] = foldClaudeStdout(initialClaudeProjection, { type: "system", subtype: "init" }).commands;
    assert.ok(command?.kind === "frame");
    return command.body;
  }
  const commands = runtime === "codex"
    ? foldCodexNotification(initialCodexProjection("root"), "turn/started", { threadId: "root", turn: { id: "native-turn" } }).commands
    : foldPiEvent(initialPiProjection, { type: "agent_start" }).commands;
  const command = commands.find((item) => item.kind === "frame");
  assert.equal(command?.kind, "frame", "native start must produce a frame");
  return command.body;
}

afterEach(() => { vi.useRealTimers(); });

function claudeInit(state = initialClaudeProjection) {
  const result = foldClaudeStdout(state, { type: "system", subtype: "init" });
  return { state: result.state, events: result.commands.flatMap((item) => item.kind === "frame" ? item.body.events : []) };
}

test("claude init only reports spontaneous root starts, never a second start", () => {
  const started = claudeInit();
  expect(started.events).toEqual([{ kind: "turn_active" }]);
  expect(claudeInit(started.state).events).toEqual([]);
  const childInit = foldClaudeStdout(initialClaudeProjection, { type: "system", subtype: "init", parent_tool_use_id: "child" });
  expect(childInit.commands.flatMap((item) => item.kind === "frame" ? item.body.events : [])).toEqual([]);
});

test("claude host prompt needs no native start, and only a root result permits another turn", () => {
  const prompted = claudePrompted(initialClaudeProjection);
  expect(claudeInit(prompted).events).toEqual([]);
  const child = foldClaudeStdout(prompted, { type: "result", parent_tool_use_id: "child", subtype: "success" });
  expect(claudeInit(child.state).events).toEqual([]);
  const ended = foldClaudeStdout(prompted, { type: "result", subtype: "success" });
  expect(claudeInit(ended.state).events).toEqual([{ kind: "turn_active" }]);
});

test.each(["claude", "codex", "pi"])("%s native activity adopts a turn without fabricating a control request", (runtime) => {
  vi.useFakeTimers({ now: 0 });
  const kernel = createSessionKernel("root");
  const body = nativeStart(runtime);
  const frame = kernel.frame(body);
  expect(eventsOf(frame).map(({ kind }) => kind)).toMatchInlineSnapshot(`
    [
      "turn_active",
    ]
  `);
  expect(statusOf(kernel.records(), "root").value).toMatchInlineSnapshot(`
    {
      "kind": "running",
      "lastEventAt": 0,
      "phase": "waiting_model",
      "sinceSeq": 0,
    }
  `);
  expect(kernel.records().every((record) => record.kind === "frame")).toBe(true);
  expect(viewOf(kernel.records()).messages.filter((message) => message.kind === "turn")).toHaveLength(1);
});

test.each(["claude", "codex", "pi"])("%s native activity preserves an existing prompt, phase and turn segment", (runtime) => {
  vi.useFakeTimers({ now: 0 });
  const kernel = createSessionKernel("root");
  kernel.request("toRuntime", { kind: "prompt", input: "go" }, { id: "prompt" });
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "call", tool: "shell" }] });
  vi.setSystemTime(10);
  kernel.frame(nativeStart(runtime));
  expect(statusOf(kernel.records(), "root").value).toMatchInlineSnapshot(`
    {
      "kind": "running",
      "lastEventAt": 10,
      "phase": {
        "callId": "call",
        "tool": "shell",
      },
      "requestId": "prompt",
      "sinceSeq": 0,
    }
  `);
  expect(viewOf(kernel.records()).messages.filter((message) => message.kind === "turn")).toHaveLength(1);
});
