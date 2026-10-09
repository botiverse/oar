import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import type { FrameBody } from "../packages/oar/src/contracts/session.js";
import { statusOf } from "../packages/oar/src/observe/agent-status.js";
import { eventsOf } from "../packages/oar/src/observe/events.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";
import { foldCodexNotification, initialCodexProjection } from "../packages/oar/src/runtimes/codex/projection.js";
import { foldPiEvent, initialPiProjection } from "../packages/oar/src/runtimes/pi/projection.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";

function nativeStart(runtime: string): FrameBody {
  const commands = runtime === "codex"
    ? foldCodexNotification(initialCodexProjection("root"), "turn/started", { threadId: "root", turn: { id: "native-turn" } }).commands
    : foldPiEvent(initialPiProjection, { type: "agent_start" }).commands;
  const command = commands.find((item) => item.kind === "frame");
  assert.equal(command?.kind, "frame", "native start must produce a frame");
  return command.body;
}

afterEach(() => { vi.useRealTimers(); });

test.each(["codex", "pi"])("%s native activity adopts a turn without fabricating a control request", (runtime) => {
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

test.each(["codex", "pi"])("%s native activity preserves an existing prompt, phase and turn segment", (runtime) => {
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
