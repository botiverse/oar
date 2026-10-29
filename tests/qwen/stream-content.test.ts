import { expect, test } from "vitest";
import type { RuntimeEventBody } from "../../packages/oar/src/contracts/session.js";
import { initialQwenProjection, qwenProjectionProfile } from "../../packages/oar/src/runtimes/qwen/projection.js";
import { foldStreamJsonStdout } from "../../packages/oar/src/shared/stream-json/projection.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";

const stream = (event: JsonRecord): JsonRecord => ({ type: "stream_event", event });
const start = (id: string) => stream({ type: "message_start", message: { id, role: "assistant", content: [] } });
const blockStart = (type: "text" | "thinking") => stream({ type: "content_block_start", index: 0, content_block: { type, [type]: "" } });
const delta = (type: "text" | "thinking", text: string) => stream({ type: "content_block_delta", index: 0, delta: { type: `${type}_delta`, [type]: text } });
const stop = stream({ type: "content_block_stop", index: 0 });
const final = (id: string, type: "text" | "thinking", text: string): JsonRecord => ({ type: "assistant", message: { id, role: "assistant", content: [{ type, [type]: text }] } });

function projector() {
  let state = initialQwenProjection();
  return (native: JsonRecord): readonly RuntimeEventBody[] => {
    const next = foldStreamJsonStdout(qwenProjectionProfile, state, native);
    ({ state } = next);
    const frames = next.commands.filter((command) => command.kind === "frame");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.body.native).toBe(native);
    return frames.flatMap((frame) => frame.body.events);
  };
}

test("Qwen's thinking and text block snapshots do not duplicate streamed content when their ids differ", () => {
  const project = projector();
  const answer = "A repeated paragraph.\nA repeated paragraph.\n";
  // Native 0.26.3 reuses block index 0 and the message_start id for deltas,
  // but allocates a new id for the final text after its thinking snapshot.
  for (const turn of [1, 2]) {
    const events = [
      start(`thinking-${turn}`), blockStart("thinking"), delta("thinking", "Synthetic reasoning."), stop,
      final(`thinking-${turn}`, "thinking", "Synthetic reasoning."),
      blockStart("text"), delta("text", "A repeated paragraph.\n"), delta("text", "A repeated paragraph.\n"), stop,
      final(`answer-${turn}`, "text", answer), stream({ type: "message_stop" }),
      { type: "result", subtype: "success", is_error: false },
    ].flatMap((frame) => project(frame));
    expect(events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("")).toBe(answer);
    expect(events.flatMap((event) => event.kind === "reasoning" && event.content.kind === "text" ? [event.content.text] : []).join("")).toBe("Synthetic reasoning.");
  }
});

test("only the adjacent completed block supplies the snapshot identity, never equal text elsewhere", () => {
  const project = projector();
  for (const frame of [start("stream"), blockStart("text"), delta("text", "same"), stop]) { project(frame); }
  // Native structure identifies this as a snapshot even if its text changes.
  // Both native payloads remain in records; comparison of text is not identity.
  expect(project(final("snapshot", "text", "different"))).toEqual([]);
  expect(project(final("next", "text", "same"))).toEqual([{ kind: "text_delta", text: "same", messageId: "next" }]);
  project(stream({ type: "message_stop" }));
  expect(project(final("final-only", "text", "same"))).toEqual([{ kind: "text_delta", text: "same", messageId: "final-only" }]);
});

test.each(["message_start", "message_stop", "result"])("%s ends the previous block's eligibility", (boundary) => {
  const project = projector();
  for (const frame of [start("stream"), blockStart("text"), delta("text", "same"), stop]) { project(frame); }
  let frame: JsonRecord = { type: "result", subtype: "success", is_error: false };
  if (boundary === "message_start") { frame = start("next"); }
  if (boundary === "message_stop") { frame = stream({ type: boundary }); }
  project(frame);
  expect(project(final("next-final", "text", "same"))).toEqual([{ kind: "text_delta", text: "same", messageId: "next-final" }]);
});

test("a block start without any emitted text does not hide its final content", () => {
  const project = projector();
  for (const frame of [start("stream"), blockStart("text"), stop]) { project(frame); }
  expect(project(final("snapshot", "text", "final only"))).toEqual([{ kind: "text_delta", text: "final only", messageId: "snapshot" }]);
});

test("an unfinished new block and another agent cannot consume an older stopped block", () => {
  const project = projector();
  for (const frame of [start("stream"), blockStart("text"), delta("text", "same"), stop]) { project(frame); }
  const child = { ...final("child", "text", "same"), parent_tool_use_id: "child-call" };
  expect(project(child)).toEqual([{ kind: "text_delta", text: "same", messageId: "child" }]);
  project(blockStart("text"));
  expect(project(final("new-block", "text", "same"))).toEqual([{ kind: "text_delta", text: "same", messageId: "new-block" }]);
});

test("other stream-json dialects still require their usual message identity", () => {
  let state = initialQwenProjection();
  const profile = { ...qwenProjectionProfile, assistantFollowsBlockStop: false };
  for (const frame of [start("stream"), blockStart("text"), delta("text", "same"), stop]) {
    ({ state } = foldStreamJsonStdout(profile, state, frame));
  }
  const { commands } = foldStreamJsonStdout(profile, state, final("different-id", "text", "same"));
  expect(commands.flatMap((command) => command.kind === "frame" ? command.body.events : [])).toEqual([
    { kind: "text_delta", text: "same", messageId: "different-id" },
  ]);
});
