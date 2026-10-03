import { expect, test } from "vitest";
import { createAcpProjectionState, projectAcpUpdate } from "../../packages/oar/src/shared/acp/projection.js";

function ended(content: unknown, rawOutput?: unknown): unknown {
  const state = createAcpProjectionState();
  projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "t1", title: "screenshot", status: "in_progress" });
  return projectAcpUpdate(state, {
    sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content,
    ...(rawOutput === undefined ? {} : { rawOutput }),
  });
}

// ACP tool content wraps each ContentBlock as `{type: "content", content}` (#73).
test("an ACP tool result's content blocks are its ordered parts", () => {
  const image = { type: "content", content: { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" } };
  expect(ended([image])).toEqual([{ kind: "tool_call_ended", callId: "t1", content: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo" }], result: "ok" }]);
  const caption = { type: "content", content: { type: "text", text: "the page" } };
  expect(ended([caption, image])).toEqual([{ kind: "tool_call_ended", callId: "t1", content: [
    { type: "text", text: "the page" }, { type: "image", mediaType: "image/png", data: "iVBORw0KGgo" },
  ], result: "ok" }]);
});

test("an ACP tool result without content falls back to rawOutput, and long text is truncated", () => {
  expect(ended([{ type: "content", content: { type: "text", text: "done" } }])).toEqual([{ kind: "tool_call_ended", callId: "t1", content: [{ type: "text", text: "done" }], result: "ok" }]);
  expect(ended([], { exit_code: 0 })).toEqual([{ kind: "tool_call_ended", callId: "t1", content: [{ type: "other", value: { exit_code: 0 } }], result: "ok", exitCode: 0 }]);
  expect(ended([{ type: "content", content: { type: "text", text: "x".repeat(10_050) } }])).toEqual([
    { kind: "tool_call_ended", callId: "t1", content: [{ type: "text", text: `${"x".repeat(10_000)}…` }], result: "ok" },
  ]);
});
