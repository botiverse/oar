import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { classifyTool, toolActionLabel } from "../../packages/oar/src/observe/tool-activity.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Friendly-Activity specimen: run the tool calls from the REAL recorded
 * fixtures through classifyTool + toolActionLabel and snapshot the friendly
 * lines beside the raw tool names — the "raw event → friendly activity" view
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
      calls.push({ runtime: "codex", tool: item.type, input: JSON.stringify({ command: item.command }) });
    }
  }
  return calls;
}

function render(calls: ToolCall[]): string {
  return `${calls.map((call) => {
    const action = classifyTool(call.runtime, call.tool, call.input);
    return `${call.tool.padEnd(20)} │ ${toolActionLabel(action.kind, "running")}${action.detail === undefined ? "" : ` — ${action.detail.slice(0, 40)}`}`;
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
