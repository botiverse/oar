import { expect, test } from "vitest";
import type { FrameBody } from "../../packages/oar/src/contracts/session.js";
import { foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";
import capture from "../fixtures/claude-synthetic-failures.json" with { type: "json" };

function replay(frames: readonly JsonRecord[]): FrameBody[] {
  let state = initialClaudeProjection;
  return frames.flatMap(frame => {
    const folded = foldClaudeStdout(state, frame);
    ({ state } = folded);
    return folded.commands.flatMap(command => command.kind === "frame" ? [command.body] : []);
  });
}

// Only the assistant was captured for the weekly limit. This result closes that turn in replay.
const end: JsonRecord = { type: "result", subtype: "success", is_error: true };
const weeklyText = "You've hit your weekly limit · resets Nov 18, 4am (America/Toronto)";

test.each([
  { frames: capture.verification, failure: "auth", status: 403, reason: capture.verification[1]?.result },
  { frames: capture.overload, failure: "overloaded", status: 529, reason: "API Error: Overloaded" },
  { frames: [capture.weeklyLimit, end], failure: "quota", status: 429, reason: weeklyText,
    resetsAt: "2026-11-18T09:00:00.000Z", rateLimitType: "seven_day" },
  { frames: [{ ...capture.weeklyLimit, api_error_params: undefined }, end], failure: "quota", status: 429, reason: weeklyText },
])("Claude keeps a synthetic $failure frame and reports its diagnostic only on the failed turn", ({ frames, ...failure }) => {
  const bodies = replay(frames);
  expect(bodies.map(body => body.native)).toEqual(frames);
  expect(bodies.flatMap(body => body.events)).toEqual([{ kind: "turn_ended", outcome: { kind: "failed", ...failure } }]);
});

test("model or API-error flag alone identifies a synthetic frame, without matching ordinary text", () => {
  const assistant = capture.weeklyLimit;
  for (const marked of [{ ...assistant, is_api_error_message: false }, { ...assistant, message: { ...assistant.message, model: "ordinary" } }]) {
    expect(replay([marked])[0]?.events).toEqual([]);
  }
  expect(replay([{ type: "assistant", message: { model: "ordinary", content: assistant.message.content } }])[0]?.events)
    .toEqual([{ kind: "text_delta", text: weeklyText }]);
});

test("a child settlement cannot consume the root error and a later root turn starts clean", () => {
  const child = { type: "result", subtype: "success", parent_tool_use_id: "child" };
  const next = { type: "result", subtype: "success" };
  const events = replay([capture.weeklyLimit, child, end, next]).flatMap(body => body.events);
  expect(events).toMatchObject([
    { kind: "turn_ended", outcome: { kind: "completed" } },
    { kind: "turn_ended", outcome: { kind: "failed", failure: "quota" } },
    { kind: "turn_ended", outcome: { kind: "completed" } },
  ]);
});

test("a Claude refusal in the assistant or result stop reason ends as model_refused", () => {
  const refused = { kind: "turn_ended", outcome: { kind: "failed", failure: "model_refused", reason: "refusal" } };
  const result = { type: "result", subtype: "success", is_error: false };
  expect(replay([{ ...result, stop_reason: "refusal" }])[0]?.events).toEqual([refused]);
  expect(replay([{ type: "assistant", message: { stop_reason: "refusal" } }, result])[1]?.events).toEqual([refused]);
});

test("a synthetic informational message stays out of the reply and preserves a successful result", () => {
  const frames = [
    { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } },
    { type: "result", subtype: "success", is_error: false },
  ];
  expect(replay(frames).flatMap(body => body.events)).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
});
