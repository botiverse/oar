import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { foldPiEvent, initialPiProjection } from "../../packages/oar/src/runtimes/pi/projection.js";

const evidence: AgentSessionEvent[] = [
  { type: "turn_start" },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "message_start", message: { role: "user", content: "BOOT", timestamp: 0 } },
  { type: "message_end", message: { role: "user", content: "BOOT", timestamp: 0 } },
  { type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: {} },
  { type: "tool_execution_update", toolCallId: "tool", toolName: "read", args: {}, partialResult: {} },
  { type: "tool_execution_end", toolCallId: "tool", toolName: "read", result: {}, isError: false },
];
test.each(evidence)("$type proves a run when agent_start preceded subscription", event => {
  const { state } = foldPiEvent(initialPiProjection, event);
  const settled = foldPiEvent(state, { type: "agent_settled", aborted: false });
  expect(settled.commands[0]?.body.events).toContainEqual({ kind: "turn_ended", outcome: { kind: "completed" } });
  expect(settled.state.runStarted).toBe(false);
});

test.each([false, true])("settlement without run evidence has no fabricated outcome, aborted=%s", aborted => {
  const config = foldPiEvent(initialPiProjection, { type: "thinking_level_changed", level: "off" });
  const queued = foldPiEvent(config.state, { type: "queue_update", steering: [], followUp: [] });
  const settled = foldPiEvent(queued.state, { type: "agent_settled", aborted });
  expect(settled.commands[0]?.body.events).toEqual([]);
});

test.each([false, true])("idle custom messages are retained but cannot prove a run, aborted=%s", aborted => {
  const message = { role: "custom", customType: "notice", content: "hello", display: true, timestamp: 0 } as const;
  const start = foldPiEvent(initialPiProjection, { type: "message_start", message });
  const end = foldPiEvent(start.state, { type: "message_end", message });
  expect(start.commands[0]?.body.native).toEqual({ type: "message_start", message });
  expect(end.commands[0]?.body.native).toEqual({ type: "message_end", message });
  expect(start.state.runStarted).toBe(false);
  expect(end.state.runStarted).toBe(false);
  expect(foldPiEvent(end.state, { type: "agent_settled", aborted }).commands[0]?.body.events).toEqual([]);
});
