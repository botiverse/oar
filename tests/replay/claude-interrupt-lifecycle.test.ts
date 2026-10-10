/* oxlint-disable max-statements -- Keep the four recorded control sequences and their assertions together. */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { claudeAbortRequested, claudePrompted, foldClaudeStdout, initialClaudeProjection, type ProjectionCommand } from "../../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

// Claude 2.1.292 + scripted provider, recorded by Lookout. stdin records the
// native experiment's controls (including a forced cancel_queued after start).
// This pins projection of those native facts; adapter selection of that flag
// is tested in claude-cancel-queued.test.ts.
const fixture = (name: string, side: string) => readFileSync(new URL(`fixtures/claude-${name}.${side}.jsonl`, import.meta.url), "utf8")
  .trim().split("\n").map((line) => asRecord(parseJson(line))).filter((row) => row !== null);

test.each([
  ["cancel-queued-collision", true, 2],
  ["cancel-queued-before-start", true, 0],
  ["cancel-queued-after-start", false, 1],
  ["plain-interrupt-after-start", false, 1],
] as const)("recorded %s: only cancellation before started returns the input", (name, dropped, turnEnds) => {
  const frames = fixture(name, "raw");
  const writes = fixture(name, "stdin");
  let state = initialClaudeProjection;
  const commands: ProjectionCommand[] = [];
  for (const frame of frames) {
    if (frame.type === "command_lifecycle" && frame.state === "queued") {
      const inputId = String(frame.command_uuid);
      expect(writes.some((write) => write.type === "user" && write.uuid === inputId)).toBe(true);
      state = claudePrompted(state, inputId);
    }
    if ((frame.type === "command_lifecycle" && frame.state === "cancelled") || frame.type === "control_response") { state = claudeAbortRequested(state); }
    const folded = foldClaudeStdout(state, frame);
    ({ state } = folded); commands.push(...folded.commands);
  }
  const events = commands.flatMap((command) => command.kind === "frame" ? command.body.events : []);
  const native = commands.flatMap((command) => (command.kind === "frame" || command.kind === "respond") && "native" in command.body ? [command.body.native] : []);
  expect(native).toEqual(frames);
  const inputId = writes.findLast((write) => write.type === "user")?.uuid;
  expect(events.filter((event) => event.kind === "input_dropped")).toEqual(dropped ? [{ kind: "input_dropped", inputId, reason: "turn_interrupted" }] : []);
  const ends = events.filter((event) => event.kind === "turn_ended");
  expect(ends).toHaveLength(turnEnds);
  if (turnEnds > 0) { expect(ends.at(-1)?.outcome).toEqual({ kind: "aborted" }); }
  expect(state.pendingInputId).toBeNull();
  expect(state.unstartedInputs.size).toBe(0);
  expect(state.turnActive).toBe(false);
});
