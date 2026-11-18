/* oxlint-disable eslint/max-statements -- Each control keeps the ordered boundary and its replay assertions together. */
/* oxlint-disable import/max-dependencies -- One boundary control across five native lifecycle readers. */
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import type { ConversationId, ConversationView, TaskId } from "@earendil-works/pi-durable";
import type { FrameBody } from "../packages/oar/src/contracts/session.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";
import { foldDsh, initialDshProjection } from "../packages/oar/src/runtimes/dsh/projection.js";
import { grokNativeTurns } from "../packages/oar/src/runtimes/grok/native-turns.js";
import { foldDurableView, initialDurableProjection } from "../packages/oar/src/runtimes/pi-durable/projection.js";
import { initialQoderProjection, qoderProjectionProfile } from "../packages/oar/src/runtimes/qoder/projection.js";
import { initialQwenProjection, qwenProjectionProfile } from "../packages/oar/src/runtimes/qwen/projection.js";
import { createAcpNativeTurnTracker } from "../packages/oar/src/shared/acp/native-turns.js";
import { streamJsonPrompted } from "../packages/oar/src/shared/stream-json/input-lifecycle.js";
import { foldStreamJsonStdout } from "../packages/oar/src/shared/stream-json/projection.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";

function isConversationId(value: number): value is ConversationId { return Number.isSafeInteger(value) && value > 0; }
function isTaskId(value: number): value is TaskId { return Number.isSafeInteger(value) && value > 0; }

function durableStart(): FrameBody {
  const id = 1;
  const taskId = 2;
  assert.ok(isConversationId(id) && isTaskId(taskId));
  const before: ConversationView = { conversation: { id }, entries: [], docs: { "pi.live": {}, "pi.agent": {}, "pi.usage": { models: {}, tools: {} } } };
  const value = { ...before, docs: { ...before.docs, "pi.live": { run: { taskId, inputs: [], turns: 0 } } } };
  return foldDurableView(initialDurableProjection(before), { kind: "value", value, ops: [], retired: false }).frame;
}

function grokStart(): FrameBody {
  const turns = createAcpNativeTurnTracker(grokNativeTurns);
  assert.ok(turns);
  let active: object | null = null;
  turns.bind({ active: () => active, adopt: () => { active = {}; return active; }, release: () => { active = null; } });
  const native = { sessionId: "root", entries: [], runningPromptId: "native" };
  return { type: "_x.ai/queue/changed", native, events: turns.project("_x.ai/queue/changed", native, "root", true) };
}

function nativeStart(runtime: string): FrameBody {
  if (runtime === "dsh") { return foldDsh(initialDshProjection("root"), { type: "native", channel: "session/event", sessionId: "root", event: { type: "turn/start", data: {} } }).frame.body; }
  if (runtime === "pi-durable") { return durableStart(); }
  if (runtime === "grok") { return grokStart(); }
  const result = runtime === "qwen"
    ? foldStreamJsonStdout(qwenProjectionProfile, initialQwenProjection(), { type: "system", subtype: "init" })
    : foldStreamJsonStdout(qoderProjectionProfile, streamJsonPrompted(initialQoderProjection(), "native", false), { type: "command_lifecycle", command_uuid: "native", state: "started" });
  const frame = result.commands.find(command => command.kind === "frame");
  assert.ok(frame?.kind === "frame");
  return frame.body;
}

test.each(["dsh", "grok", "pi-durable", "qwen", "qoder"])("%s preserves outside content and then opens its native turn", runtime => {
  const kernel = createSessionKernel("root");
  kernel.frame({ type: "early", native: {}, events: [{ kind: "text_delta", text: "outside" }] });
  const before = viewOf(kernel.records());
  expect(before.status.kind).toBe("idle");
  expect(before.openTurn).toBe(-1);
  const start = nativeStart(runtime);
  expect(start.events).toContainEqual({ kind: "turn_active", ...(runtime === "qoder" ? { inputId: "native" } : {}) });
  kernel.frame(start);
  kernel.frame({ type: "inside", native: {}, events: [{ kind: "text_delta", text: "inside" }] });
  const view = viewOf(kernel.records());
  expect(view.messages.map(message => message.kind)).toEqual(["activity", "turn"]);
  expect(view.messages.at(-1)).toMatchObject({ sections: [{ parts: [{ text: "inside" }] }] });
  expect(view.status.kind).toBe("running");
  expect(view.status).not.toHaveProperty("activity");
});
