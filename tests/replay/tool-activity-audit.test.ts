import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { expect, test } from "vitest";
import { classifyTool, type ToolAction, type ToolActionKind } from "../../packages/oar/src/observe/tool-activity.js";
import { createAcpProjectionState, projectAcpUpdate } from "../../packages/oar/src/shared/acp/projection.js";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

interface AuditTool {
  tool: string;
  nativeInputs: unknown[];
  events: { kind: string; input?: string }[];
}
interface Audit { tools: AuditTool[] }

const evidence = path.join(import.meta.dirname, "../../experiments/tool-activity-audit/results");
function readAudit(name: string): JsonRecord | null {
  const text = readFileSync(path.join(evidence, `${name}.json`), "utf8");
  return asRecord(parseJson(text));
}
function audit(runtime: string): Audit {
  const data = readAudit(runtime);
  return { tools: asRecordList(data?.tools).map(call => ({
    tool: String(call.tool),
    nativeInputs: Array.isArray(call.nativeInputs) ? call.nativeInputs : [],
    events: asRecordList(call.events).map(event => typeof event.input === "string" ? { kind: String(event.kind), input: event.input } : { kind: String(event.kind) }),
  })) };
}

const ACP = new Set(["grok", "kimi", "opencode", "codebuddy", "antigravity"]);
function inputOf(runtime: string, call: AuditTool): string | undefined {
  if (!ACP.has(runtime)) {
    return call.events.findLast(event => event.input !== undefined)?.input;
  }
  const state = createAcpProjectionState();
  let latest: string | undefined = undefined;
  for (const [index, rawInput] of call.nativeInputs.entries()) {
    const events = projectAcpUpdate(state, {
      sessionUpdate: index === 0 ? "tool_call" : "tool_call_update",
      toolCallId: "recorded", title: call.tool, status: "in_progress", rawInput,
    });
    for (const event of events) {
      if (event.kind === "tool_call_started" || event.kind === "tool_call_input") { latest = event.input; }
    }
  }
  return latest;
}

function commandFor(runtime: string): string {
  if (runtime === "codex") { return String.raw`/bin/bash -lc "printf 'AUDIT_COMMAND\\n'"`; }
  return runtime === "codebuddy" ? "pwd" : String.raw`printf 'AUDIT_COMMAND\n'`;
}
function checkCommand(runtime: string, action: ToolAction): void {
  expect(action.command).toBe(commandFor(runtime));
  expect(action.detail).toBe(commandFor(runtime));
  expect(action.description).toBe(["grok", "antigravity", "dsh"].includes(runtime) ? "Print audit marker" : undefined);
}
function checkEdit(runtime: string, action: ToolAction): void {
  const file = `${runtime === "qoder" ? "<probe>" : "<project>"}/audit.txt`;
  expect(action.paths).toEqual([file]);
  expect(action.detail).toBe(file);
}

for (const runtime of ["claude", "codex", "grok", "kimi", "opencode", "qwen", "qoder", "codebuddy", "antigravity", "dsh", "pi"]) {
  test(`${runtime}: audited command, edit and MCP input classify through their actual projection`, () => {
    const calls = audit(runtime).tools;
    const expected: ToolActionKind[] = ["run_command", "edit_file", runtime === "opencode" ? "other" : "mcp"];
    expect(calls).toHaveLength(3);
    for (const [index, call] of calls.entries()) {
      const input = inputOf(runtime, call);
      const action = classifyTool(runtime, call.tool, input);
      expect(action.kind, `${call.tool}: ${input}`).toBe(expected[index]);
      if (index === 0) {
        checkCommand(runtime, action);
      } else if (index === 1) {
        checkEdit(runtime, action);
      }
    }
  });
}

for (const runtime of ["kimi", "codebuddy", "antigravity"]) {
  test(`${runtime}: recorded MCP text arguments remain the complete native object`, () => {
    const call = audit(runtime).tools.at(2);
    assert.ok(call);
    const input = inputOf(runtime, call);
    expect(parseJson(input ?? "")).toEqual(call.nativeInputs.at(-1));
    expect(input).not.toBe("ACTUAL");
  });
}

test("recorded Codex collaboration waits classify as subagent operations without invented input", () => {
  const recorded = readAudit("collaboration");
  const events = asRecordList(recorded?.afterFix).flatMap(frame => asRecordList(frame.events));
  const started = events.find(event => event.kind === "tool_call_started");
  assert.ok(started && typeof started.tool === "string");
  expect(started.input).toBeUndefined();
  expect(classifyTool("codex", started.tool)).toEqual({ kind: "subagent" });
});

test("only the audited Qwen MCP dispatch shape is classified as MCP", () => {
  const call = audit("qwen").tools.at(2);
  assert.ok(call);
  const input = inputOf("qwen", call);
  expect(classifyTool("qwen-aimock", "tool_call", input).kind).toBe("mcp");
  for (const unknown of [undefined, "{", "{}", '{"name":"other_deferred_tool","arguments":{}}']) {
    expect(classifyTool("qwen", "tool_call", unknown).kind).toBe("other");
  }
});

test("names and input spellings not recorded for these runtimes stay unknown", () => {
  for (const runtime of ["qwen", "qoder", "codebuddy", "antigravity", "dsh", "unknown", "constructor"]) {
    for (const tool of ["unrecorded_tool", "constructor", "toString", "__proto__"]) {
      expect(classifyTool(runtime, tool)).toEqual({ kind: "other", detail: tool });
      expect(classifyTool(runtime, tool, "{}")).toEqual({ kind: "other", detail: tool });
    }
  }
  expect(classifyTool("qwen", "Bash").kind).toBe("other");
  expect(classifyTool("claude", "run_command").kind).toBe("other");
  expect(classifyTool("dsh", "run_command").kind).toBe("other");
  expect(classifyTool("qwen", "mcp_audit_echo").kind).toBe("other");
  expect(classifyTool("antigravity", "run_command", '{"command":"unrecorded spelling"}').command).toBeUndefined();
  expect(classifyTool("antigravity", "edit_file", '{"file_path":"unrecorded spelling"}').paths).toBeUndefined();
});
