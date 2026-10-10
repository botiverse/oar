import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyTool, toolActionLabel } from "../packages/oar/src/observe/tool-activity.js";

test("classifyTool unifies each runtime's shell tool to run_command", () => {
  assert.equal(classifyTool("claude", "Bash", JSON.stringify({ command: "echo hi" })).kind, "run_command");
  assert.equal(classifyTool("codex-aimock", "commandExecution", JSON.stringify({ command: "ls" })).kind, "run_command");
  assert.equal(classifyTool("pi", "bash", JSON.stringify({ command: "pwd" })).kind, "run_command");
});

test("classifyTool maps file / search / web / mcp across runtimes", () => {
  assert.equal(classifyTool("claude", "Read").kind, "read_file");
  assert.equal(classifyTool("claude", "Write").kind, "edit_file");
  assert.equal(classifyTool("codex", "fileChange").kind, "edit_file");
  assert.equal(classifyTool("pi", "grep").kind, "search");
  assert.equal(classifyTool("claude", "WebSearch").kind, "web");
  assert.equal(classifyTool("codex", "mcpToolCall").kind, "mcp");
  assert.equal(classifyTool("claude", "mcp__github__create_issue").kind, "mcp");
});

test("classifyTool falls back to other with the tool name for unknown/custom tools", () => {
  const action = classifyTool("pi", "some_custom_tool");
  assert.deepEqual(action, { kind: "other", detail: "some_custom_tool" });
});

test("classifyTool extracts a detail from the input across field spellings", () => {
  assert.equal(classifyTool("claude", "Bash", JSON.stringify({ command: "echo hi" })).detail, "echo hi");
  assert.equal(classifyTool("codex", "commandExecution", JSON.stringify({ cmd: "ls -la" })).detail, "ls -la");
  assert.equal(classifyTool("claude", "Read", JSON.stringify({ file_path: "/a/b.ts" })).detail, "/a/b.ts");
  // codex nests the command in an argv array
  assert.equal(classifyTool("codex", "commandExecution", JSON.stringify({ command: ["bash", "-lc", "echo deep"] })).detail, "echo deep");
});

test("classifyTool reads cursor's tool types and its shell command", () => {
  // `toolCall.args` of a `@cursor/sdk` 1.0.35 shell call, recorded 2026-10-03.
  assert.deepEqual(classifyTool("cursor", "shell", JSON.stringify({ command: "echo TOOL-MARK-4412", timeout: 30_000 })), {
    kind: "run_command", detail: "echo TOOL-MARK-4412", command: "echo TOOL-MARK-4412",
  });
  assert.deepEqual(classifyTool("cursor", "read", JSON.stringify({ path: "/tmp/note.txt" })), { kind: "read_file", detail: "/tmp/note.txt", paths: ["/tmp/note.txt"] });
  assert.equal(classifyTool("cursor", "edit").kind, "edit_file");
  assert.equal(classifyTool("cursor", "glob").kind, "search");
  assert.equal(classifyTool("cursor", "webFetch").kind, "fetch");
  assert.equal(classifyTool("cursor", "task").kind, "other");
});

test("classifyTool reads a grok shell input with what it carries", () => {
  // The recorded opening input is `{command, description}` (tests/replay); one lacking a key still classifies.
  assert.deepEqual(classifyTool("grok", "run_terminal_command", JSON.stringify({ description: "List the files" })), {
    kind: "run_command", description: "List the files",
  });
  assert.deepEqual(classifyTool("grok", "run_terminal_command"), { kind: "run_command" });
});

// #321: fetching one page is not a web search, and a subagent call is a subagent, not "Running Agent".
test("classifyTool reads page fetches and subagent calls with their recorded inputs", () => {
  assert.deepEqual(classifyTool("claude", "WebFetch", JSON.stringify({ url: "https://example.com/a", prompt: "Summarize" })), { kind: "fetch", detail: "https://example.com/a" });
  // claude 2.1.x tests/replay/fixtures/claude-background-tasks.raw.jsonl; opencode tests/replay/fixtures/opencode-acp-v2-child.json.
  const claude = { description: "Run echo command", subagent_type: "general-purpose", prompt: "Run the shell command `echo SUB_OK` and report the exact output.", run_in_background: false };
  assert.deepEqual(classifyTool("claude", "Agent", JSON.stringify(claude)), { kind: "subagent", detail: "Run echo command", description: "Run echo command" });
  const opencode = { agent: "general", description: "Echo child check", prompt: "Run `echo CHILD-OK-7731` in its shell and report the output." };
  assert.deepEqual(classifyTool("opencode", "subagent", JSON.stringify(opencode)), { kind: "subagent", detail: "Echo child check", description: "Echo child check" });
  assert.deepEqual(classifyTool("claude", "Agent"), { kind: "subagent" });
  // `Task` is Agent's alias in claude 2.1.292: a call made under it is recorded under it.
  assert.deepEqual(classifyTool("claude", "Task", JSON.stringify(claude)), { kind: "subagent", detail: "Run echo command", description: "Run echo command" });
  assert.equal(toolActionLabel("fetch", "running"), "Fetching page");
  assert.equal(toolActionLabel("subagent", "running"), "Running subagent");
  assert.equal(toolActionLabel("web", "writing"), "Preparing web search");
});

test("toolActionLabel gives tense-correct labels per state", () => {
  assert.equal(toolActionLabel("run_command", "running"), "Running command");
  assert.equal(toolActionLabel("run_command", "done"), "Ran command");
  assert.equal(toolActionLabel("read_file", "failed"), "Read failed");
});

// codex reports the model waiting as a `sleep` item (#84): a wait, with the time it asked for.
test("classifyTool reads codex sleep as a wait with the asked duration", () => {
  assert.deepEqual(classifyTool("codex", "sleep", JSON.stringify({ durationMs: 50_000 })), {
    kind: "wait",
    durationMs: 50_000,
  });
  assert.deepEqual(classifyTool("codex", "sleep"), { kind: "wait" });
  for (const input of [JSON.stringify({ durationMs: -1 }), JSON.stringify({ durationMs: 0 }), JSON.stringify({ durationMs: "50000" }), "{not json"]) {
    assert.deepEqual(classifyTool("codex", "sleep", input), { kind: "wait" });
  }
  assert.equal(toolActionLabel("wait", "running"), "Waiting");
  assert.equal(toolActionLabel("wait", "done"), "Waited");
});

// #166: `paths` on read_file / edit_file. Each runtime's read and write tools get the one path
// `detail` has always read, in their own input shapes (claude's tools; the tool schemas of
// pi-coding-agent 1.0.4 and `@cursor/sdk` 1.0.36; opencode's are pinned against its recording
// in tests/replay/tool-activity.test.ts).
test("classifyTool gives each runtime's file tools their one path as paths, the same as detail", () => {
  const calls: readonly (readonly [string, string, Readonly<Record<string, unknown>>, string])[] = [
    ["claude", "Read", { file_path: "/w/a.ts", offset: 1, limit: 20 }, "/w/a.ts"],
    ["claude", "Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y" }, "/w/a.ts"],
    ["claude", "Write", { file_path: "/w/a.ts", content: "x" }, "/w/a.ts"],
    ["pi", "read", { path: "src/a.ts", offset: 1 }, "src/a.ts"],
    // An `ls` call's one path is the directory it lists.
    ["pi", "ls", { path: "src" }, "src"],
    ["pi", "edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] }, "src/a.ts"],
    ["pi", "write", { path: "src/a.ts", content: "x" }, "src/a.ts"],
    ["cursor", "read", { path: "/w/a.ts" }, "/w/a.ts"],
    ["cursor", "ls", { path: "/w" }, "/w"],
    ["cursor", "edit", { path: "/w/a.ts" }, "/w/a.ts"],
    ["cursor", "write", { path: "/w/a.ts", fileText: "x" }, "/w/a.ts"],
    ["cursor", "delete", { path: "/w/a.ts" }, "/w/a.ts"],
    ["opencode", "read", { filePath: "/w/a.ts" }, "/w/a.ts"],
  ];
  for (const [runtime, tool, input, file] of calls) {
    const { detail, paths } = classifyTool(runtime, tool, JSON.stringify(input));
    assert.deepEqual({ detail, paths }, { detail: file, paths: [file] }, `${runtime} ${tool}`);
  }
});

test("classifyTool gives claude NotebookEdit the notebook it edits as paths and detail", () => {
  // `notebook_path` was never a detail; as the file the call edits it is both now.
  const input = JSON.stringify({ notebook_path: "/w/n.ipynb", cell_id: "c1", new_source: "x" });
  assert.deepEqual(classifyTool("claude", "NotebookEdit", input), { kind: "edit_file", detail: "/w/n.ipynb", paths: ["/w/n.ipynb"] });
});

test("classifyTool leaves paths out when a call names no file, and off other kinds", () => {
  assert.deepEqual(classifyTool("claude", "Read"), { kind: "read_file" });
  assert.deepEqual(classifyTool("opencode", "write", "{}"), { kind: "edit_file" });
  assert.deepEqual(classifyTool("codex", "fileChange"), { kind: "edit_file" });
  assert.deepEqual(classifyTool("codex", "fileChange", "[]"), { kind: "edit_file" });
  assert.deepEqual(classifyTool("claude", "NotebookEdit", JSON.stringify({ cell_id: "c1", new_source: "x" })), { kind: "edit_file" });
  assert.deepEqual(classifyTool("pi", "grep", JSON.stringify({ pattern: "x", path: "src" })), { kind: "search", detail: "src" });
  assert.deepEqual(classifyTool("claude", "Bash", JSON.stringify({ command: "cat a.ts" })), { kind: "run_command", detail: "cat a.ts", command: "cat a.ts" });
});

test("classifyTool lists a codex fileChange's paths once each, a rename's target after its source", () => {
  // A rename onto a file the same patch deletes: the target is also a change's own path.
  const changes = [
    { path: "/w/a.txt", kind: { type: "update", move_path: "/w/b.txt" }, diff: "" },
    { path: "/w/b.txt", kind: { type: "delete" }, diff: "" },
    { path: "/w/c.txt", kind: { type: "update", move_path: null }, diff: "" },
  ];
  assert.deepEqual(classifyTool("codex-aimock", "fileChange", JSON.stringify(changes)), {
    kind: "edit_file", detail: "/w/a.txt", paths: ["/w/a.txt", "/w/b.txt", "/w/c.txt"],
  });
});
