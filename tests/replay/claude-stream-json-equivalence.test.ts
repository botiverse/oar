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
