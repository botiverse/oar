import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

test("only a completed file change reports the recorded applied kinds and move target", () => {
  const lines = readFileSync(join(import.meta.dirname, "fixtures", "codex-file-change.raw.jsonl"), "utf8").trim().split("\n");
  const events = lines.flatMap(line => {
    const frame = asRecord(parseJson(line));
    if (asRecord(frame?.item)?.type !== "fileChange" || typeof frame?.method !== "string") { return []; }
    const { commands } = foldCodexNotification(initialCodexProjection("root"), frame.method, frame);
    return commands.flatMap(command => command.kind === "frame" ? command.body.events : []);
  });
  expect(events).toHaveLength(2);
  expect(events[0]).not.toHaveProperty("fileChanges");
  expect(events[1]).toMatchObject({ kind: "tool_call_ended", fileChanges: [
    { path: "<cwd>/added.txt", kind: "added" }, { path: "<cwd>/gone.txt", kind: "deleted" },
    { path: "<cwd>/notes.txt", kind: "modified" }, { path: "<cwd>/old-name.txt", kind: "modified", moveTo: "<cwd>/new-name.txt" },
  ] });
});
