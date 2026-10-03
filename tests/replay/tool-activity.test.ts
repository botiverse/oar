import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { classifyTool, toolActionLabel } from "../../packages/oar/src/observe/tool-activity.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Friendly-Activity specimen: run the tool calls from the REAL recorded
 * fixtures through classifyTool + toolActionLabel and snapshot the friendly
 * lines beside the raw tool names: the "raw event → friendly activity" view
 * the way coxswain will render it, pinned per runtime.
 */
const here = import.meta.dirname;

interface ToolCall { runtime: string; tool: string; input?: string }

function toolCallsFromClaude(lines: string[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const line of lines) {
    const message = asRecord(parseJson(line));
    if (message?.type === "assistant") {
      const content = asRecord(message.message)?.content;
      for (const raw of Array.isArray(content) ? content : []) {
        const block = asRecord(raw);
        if (block?.type === "tool_use") {
          calls.push({ runtime: "claude", tool: String(block.name), input: JSON.stringify(block.input) });
        }
      }
    }
  }
  return calls;
}

// Only items that become tool_call events (see codex projection TOOL_ITEM_TYPES).
const CODEX_TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch"]);

function toolCallsFromCodex(lines: string[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const line of lines) {
    const frame = asRecord(parseJson(line));
    const item = frame?.method === "item/started" ? asRecord(frame.item) : null;
    if (item !== null && typeof item.type === "string" && CODEX_TOOL_TYPES.has(item.type)) {
      // As the projection hands it on (codex/item-detail.ts): commandExecution's input is the bare command line.
      calls.push(typeof item.command === "string"
        ? { runtime: "codex", tool: item.type, input: item.command }
        : { runtime: "codex", tool: item.type });
    }
  }
  return calls;
}

function toolCallsFromPi(lines: string[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const line of lines) {
    const event = asRecord(parseJson(line));
    if (event?.type === "tool_execution_start") {
      calls.push({ runtime: "pi", tool: String(event.toolName), input: JSON.stringify(event.args) });
    }
  }
  return calls;
}

function fixture(name: string): string[] {
  return readFileSync(path.join(here, "fixtures", name), "utf8").split("\n").filter((l) => l.trim());
}

function render(calls: ToolCall[]): string {
  return `${calls.map((call) => {
    const action = classifyTool(call.runtime, call.tool, call.input);
    return `${call.tool.padEnd(20)} │ ${toolActionLabel(action.kind, "running")}${action.detail === undefined ? "" : `: ${action.detail.slice(0, 40)}`}`;
  }).join("\n")}\n`;
}

test("claude tool calls render as friendly activity", async () => {
  const lines = readFileSync(path.join(here, "fixtures", "claude-tool-round.raw.jsonl"), "utf8").split("\n").filter((l) => l.trim());
  await expect(render(toolCallsFromClaude(lines))).toMatchFileSnapshot(path.join(here, "fixtures", "claude-tool-round.activity.txt"));
});

test("codex tool calls render as friendly activity", async () => {
  const lines = readFileSync(path.join(here, "fixtures", "codex-tool-round.raw.jsonl"), "utf8").split("\n").filter((l) => l.trim());
  await expect(render(toolCallsFromCodex(lines))).toMatchFileSnapshot(path.join(here, "fixtures", "codex-tool-round.activity.txt"));
});

test("pi tool calls render as friendly activity", async () => {
  const lines = render(toolCallsFromPi(fixture("pi-tool-round.raw.jsonl")));
  await expect(lines).toMatchFileSnapshot(path.join(here, "fixtures", "pi-tool-round.activity.txt"));
});

function shellFields(call: ToolCall | undefined): { command: string | undefined; description: string | undefined } {
  if (call === undefined) {
    return { command: undefined, description: undefined };
  }
  const { command, description } = classifyTool(call.runtime, call.tool, call.input);
  return { command, description };
}

test("shell calls carry their command, and claude's its description, as recorded", () => {
  const claude = toolCallsFromClaude(fixture("claude-tool-round.raw.jsonl")).find((c) => c.tool === "Bash");
  const [codex] = toolCallsFromCodex(fixture("codex-tool-round.raw.jsonl"));
  const [pi] = toolCallsFromPi(fixture("pi-tool-round.raw.jsonl"));
  expect(shellFields(claude)).toEqual({ command: "echo oar-replay-marker", description: "Echo the marker string" });
  expect(shellFields(codex)).toEqual({ command: "/bin/bash -lc 'echo oar-codex-marker'", description: undefined });
  expect(shellFields(pi)).toEqual({ command: "echo oar-round-one", description: undefined });
});
