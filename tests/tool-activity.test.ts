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
  assert.equal(classifyTool("claude", "WebFetch").kind, "web");
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

test("toolActionLabel gives tense-correct labels per state", () => {
  assert.equal(toolActionLabel("run_command", "running"), "Running command");
  assert.equal(toolActionLabel("run_command", "done"), "Ran command");
  assert.equal(toolActionLabel("read_file", "failed"), "Read failed");
});
