import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection, type ProjectionCommand } from "../../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const directory = new URL("fixtures/", import.meta.url);
const fixtures = readdirSync(directory).filter((name) => name.startsWith("claude-") && name.endsWith(".raw.jsonl"));

function recordedCommand(command: ProjectionCommand, native: JsonRecord): unknown {
  if (command.kind === "toApp") {
    expect(command.native).toBe(native);
    return { ...command, native: "<original frame>" };
  }
  expect("native" in command.body && command.body.native).toBe(native);
  return { ...command, body: { ...command.body, native: "<original frame>" } };
}

// Captured on 6ce480c before extracting the stream-json core. Unlike the
// concise projected.txt specimens, these pin every event field and its order,
// every control command and agent path, and the original native frame itself.
// The 2026-11-02 projection adds native-reported turn_ended inputId/inputIds; raw recordings are unchanged.
// Host-side prompt/abort interleavings have their own recorded session tests.
for (const fixture of fixtures) {
  test(`stream-json extraction preserves every frame of ${fixture}`, async () => {
    let state = claudePrompted(initialClaudeProjection);
    const rows: string[] = [];
    for (const line of readFileSync(new URL(fixture, directory), "utf8").split("\n").filter(Boolean)) {
      const native = asRecord(parseJson(line));
      assert.ok(native !== null);
      const { state: next, commands } = foldClaudeStdout(state, native);
      state = next;
      rows.push(JSON.stringify(commands.map((command) => recordedCommand(command, native))));
    }
    const baseline = new URL(fixture.replace(".raw.jsonl", ".stream-json.jsonl"), directory);
    await expect(`${rows.join("\n")}\n`).toMatchFileSnapshot(fileURLToPath(baseline));
  });
}

test("a compacting heartbeat starts once per agent until a clear, boundary, or terminal result", () => {
  let state = initialClaudeProjection;
  const status = { type: "system", subtype: "status", status: "compacting", compact_output_chars: 0 };
  const child = { ...status, parent_tool_use_id: "child" };
  const boundary = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } };
  const frames = [status, status, child, { ...status, compact_output_chars: 20 }, { ...status, status: null },
    status, boundary, status, { type: "result", subtype: "success" }, status, child];
  const readings = frames.map(frame => {
    const next = foldClaudeStdout(state, frame);
    ({ state } = next);
    return next.commands.flatMap(command => command.kind === "frame" && command.body.events.some(event => event.kind === "compaction_started")
      ? [command.agentPath.join("/") || "root"] : []);
  });
  expect(readings).toEqual([["root"], [], ["child"], [], [], ["root"], [], ["root"], [], ["root"], []]);
});
