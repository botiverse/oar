import assert from "node:assert/strict";
import { test } from "vitest";
import type { ViewPart } from "../packages/oar/src/observe/session-view.js";
import { groupToolActivity, toolGroupSummary } from "../packages/oar/src/observe/tool-groups.js";
import type { ToolActionKind } from "../packages/oar/src/observe/tool-activity.js";

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
  assert.equal(toolGroupSummary([]), "Thought");
});

test("reasoning-only groups have a summary while running and after ending", () => {
  const [group] = groupToolActivity("claude", [thought]);
  assert.ok(group?.kind === "tools");
  assert.equal(toolGroupSummary(group.counts, "running"), "Thinking…");
  assert.equal(toolGroupSummary(group.counts, "done"), "Thought");
  assert.equal(toolGroupSummary([{ kind: "run_command", count: 1 }], "running"), "Ran a command");
});

const summaries = {
  run_command: ["run_command", "Ran a command", "Ran 2 commands"],
  read_file: ["read_file", "Read a file", "Read 2 files"],
  edit_file: ["edit_file", "Edited a file", "Edited 2 files"],
  search: ["search", "Searched", "Searched 2 times"],
  web: ["web", "Searched the web", "Searched the web 2 times"],
  fetch: ["fetch", "Fetched a page", "Fetched 2 pages"],
  subagent: ["subagent", "Ran a subagent", "Ran 2 subagents"],
  mcp: ["mcp", "Used a tool", "Used 2 tools"],
  wait: ["wait", "Waited", "Waited 2 times"],
  other: ["other", "Used a tool", "Used 2 tools"],
} satisfies { [Kind in ToolActionKind]: [Kind, string, string] };

test.each(Object.values(summaries))("summary for %s handles singular and plural counts", (kind, singular, plural) => {
  assert.equal(toolGroupSummary([{ kind, count: 1 }]), singular);
  assert.equal(toolGroupSummary([{ kind, count: 2 }]), plural);
});

test("groupToolActivity counts a codex sleep as a wait", () => {
  const parts = [text("I'll wait."), call({ id: "1", tool: "sleep", input: { durationMs: 50_000 }, result: "ended" }), text("Done waiting.")];
  const [, group] = groupToolActivity("codex", parts);
  assert.ok(group?.kind === "tools");
  assert.deepEqual(group.counts, [{ kind: "wait", count: 1 }]);
  assert.equal(toolGroupSummary(group.counts), "Waited");
});

test("toolGroupSummary words a wait", () => {
  assert.equal(toolGroupSummary([{ kind: "wait", count: 1 }]), "Waited");
  assert.equal(toolGroupSummary([{ kind: "run_command", count: 1 }, { kind: "wait", count: 2 }]), "Ran a command, waited 2 times");
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
