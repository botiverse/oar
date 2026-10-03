import assert from "node:assert/strict";
import { test } from "vitest";
import type { ViewPart } from "../packages/oar/src/observe/session-view.js";
import { groupToolActivity, toolGroupSummary } from "../packages/oar/src/observe/tool-groups.js";

const text = (value: string): ViewPart => ({ kind: "text", text: value });
const thought: ViewPart = { kind: "reasoning", content: { kind: "redacted" } };
interface Call { readonly id: string; readonly tool: string; readonly input: unknown; readonly result?: "running" | "ok" | "failed" | "ended" }
function call({ id, tool, input, result = "ok" }: Call): ViewPart {
  return { kind: "tool", callId: id, tool, input: typeof input === "string" ? input : JSON.stringify(input), result };
}

test("groupToolActivity groups the work between a turn's words and leaves the words in place", () => {
  const parts = [
    text("Let me look."),
    thought,
    call({ id: "1", tool: "commandExecution", input: "/bin/bash -lc 'ls'" }),
    call({ id: "2", tool: "webSearch", input: { query: "kimi" } }),
    call({ id: "3", tool: "commandExecution", input: "/bin/bash -lc 'npm test'", result: "failed" }),
    text("One test fails."),
    call({ id: "4", tool: "commandExecution", input: "/bin/bash -lc 'git diff'", result: "running" }),
  ];
  const segments = groupToolActivity("codex", parts);
  assert.deepEqual(segments.map((s) => [s.kind, s.index]), [["part", 0], ["tools", 1], ["part", 5], ["tools", 6]]);
  const [, first, , last] = segments;
  assert.ok(first?.kind === "tools" && last?.kind === "tools");
  assert.equal(first.parts.length, 4);
  assert.deepEqual(first.counts, [{ kind: "run_command", count: 2 }, { kind: "web", count: 1 }]);
  assert.equal(first.failed, 1);
  assert.equal(first.running, undefined);
  assert.equal(last.running?.callId, "4");
});

test("toolGroupSummary words the counts, MCP and unknown tools alike", () => {
  assert.equal(toolGroupSummary([{ kind: "run_command", count: 3 }, { kind: "read_file", count: 1 }]), "Ran 3 commands, read a file");
  assert.equal(toolGroupSummary([{ kind: "web", count: 1 }]), "Searched the web");
  assert.equal(toolGroupSummary([{ kind: "mcp", count: 1 }, { kind: "edit_file", count: 2 }, { kind: "other", count: 1 }]), "Used 2 tools, edited 2 files");
  assert.equal(toolGroupSummary([]), "");
});

test("a claude run reads by claude's tool names", () => {
  const [group] = groupToolActivity("claude", [
    call({ id: "1", tool: "Read", input: { file_path: "a.ts" } }),
    call({ id: "2", tool: "Edit", input: { file_path: "a.ts" } }),
    call({ id: "3", tool: "Bash", input: { command: "npm test" } }),
  ]);
  assert.ok(group?.kind === "tools");
  assert.equal(toolGroupSummary(group.counts), "Read a file, edited a file, ran a command");
});
