import { expect, test } from "vitest";
import type { Frame, RawEvent } from "../packages/oar/src/index.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { eventsOf } from "../packages/oar/src/observe/events.js";
import { contentOfLegacyOutput } from "../packages/oar/src/observe/legacy.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";

// A tool end as OAR before 0.14.0 recorded it: the result as one `output` string.
function isFrame(value: unknown): value is Frame {
  return asRecord(value)?.kind === "frame";
}

function legacyEnd(seq: number, output: string): Frame {
  const events = [{ kind: "tool_call_ended", callId: "c1", output, result: "ok" }];
  const record: unknown = structuredClone({ kind: "frame", seq, sessionId: "s", agentPath: [], receivedAt: 0, body: { type: "user", native: {}, events } });
  if (!isFrame(record)) {
    throw new Error("not a frame");
  }
  return record;
}

test("a pre-0.14.0 output reads as content: claude's stringified blocks, its quoted string, and plain text", () => {
  const blocks = [{ type: "text", text: "shot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }];
  expect(contentOfLegacyOutput(JSON.stringify(blocks))).toEqual([{ type: "text", text: "shot" }, { type: "image", mediaType: "image/png", data: "iVBOR" }]);
  expect(contentOfLegacyOutput(JSON.stringify("nope"))).toEqual([{ type: "text", text: "nope" }]);
  expect(contentOfLegacyOutput("✔ add\n")).toEqual([{ type: "text", text: "✔ add\n" }]);
  expect(contentOfLegacyOutput('{"exit_code":0}')).toEqual([{ type: "text", text: '{"exit_code":0}' }]);
});

test("old records replay through eventsOf and the session view with content", () => {
  const record: RawEvent = legacyEnd(3, "contents");
  expect(eventsOf(record)).toMatchObject([{ kind: "tool_call_ended", callId: "c1", content: [{ type: "text", text: "contents" }], result: "ok" }]);
  expect(eventsOf(record)[0]).not.toHaveProperty("output");
  const records: RawEvent[] = [
    { kind: "request", id: "r1", direction: "toRuntime", seq: 0, sessionId: "s", agentPath: [], receivedAt: 0, body: { kind: "prompt", input: "go" } },
    { kind: "response", requestId: "r1", seq: 1, sessionId: "s", agentPath: [], receivedAt: 0, body: { kind: "accepted" } },
    { kind: "frame", seq: 2, sessionId: "s", agentPath: [], receivedAt: 0, body: { type: "assistant", native: {}, events: [{ kind: "tool_call_started", callId: "c1", tool: "Read", input: "f" }] } },
    record,
  ];
  const parts = viewOf(records).messages.flatMap((message) => (message.kind === "turn" ? message.sections.flatMap((section) => section.parts) : []));
  expect(parts).toMatchObject([{ kind: "tool", callId: "c1", content: [{ type: "text", text: "contents" }], result: "ok" }]);
});
