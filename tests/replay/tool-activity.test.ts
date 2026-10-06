import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { classifyTool, toolActionLabel } from "../../packages/oar/src/observe/tool-activity.js";
import { createAcpProjectionState, projectAcpUpdate } from "../../packages/oar/src/shared/acp/projection.js";
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
const CODEX_TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch", "sleep"]);

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

/**
 * The ACP vendor snapshots (experiments/acp-vendor-snapshot.ts) keep each tool frame's
 * `title`, `kind`, `status` and the KEYS of its `rawInput`, not their values; each recorded
 * one call. The frames run through the ACP projection, so the call starts where
 * `tool_call_started` really does (the opening `tool_call`), with each recorded key holding
 * its own name in brackets: what a field is read from, never a value the runtime did not send.
 */
function toolCallsFromAcpSnapshot(runtime: "grok" | "kimi" | "opencode"): ToolCall[] {
  const text = readFileSync(path.join(here, "fixtures", `${runtime}-acp-v1.vendor.json`), "utf8");
  const snapshot = asRecord(parseJson(text));
  const frames: unknown = asRecord(snapshot?.prompt)?.tools;
  const state = createAcpProjectionState();
  return (Array.isArray(frames) ? frames : []).flatMap((raw: unknown) => {
    const { sessionUpdate, title, kind, status, rawInputKeys } = asRecord(raw) ?? {};
    const keys = Array.isArray(rawInputKeys) ? rawInputKeys.filter((key): key is string => typeof key === "string") : [];
    const events = projectAcpUpdate(state, {
      toolCallId: "recorded",
      sessionUpdate,
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
      ...(keys.length === 0 ? {} : { rawInput: Object.fromEntries(keys.map((key) => [key, `<${key}>`])) }),
    });
    return events.flatMap((event): ToolCall[] => (event.kind === "tool_call_started"
      ? [{ runtime, tool: event.tool, ...(event.input === undefined ? {} : { input: event.input }) }]
      : []));
  });
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

test("grok tool calls render as friendly activity", async () => {
  await expect(render(toolCallsFromAcpSnapshot("grok"))).toMatchFileSnapshot(path.join(here, "fixtures", "grok-acp-v1.activity.txt"));
});

test("kimi tool calls render as friendly activity", async () => {
  await expect(render(toolCallsFromAcpSnapshot("kimi"))).toMatchFileSnapshot(path.join(here, "fixtures", "kimi-acp-v1.activity.txt"));
});

test("opencode tool calls render as friendly activity", async () => {
  await expect(render(toolCallsFromAcpSnapshot("opencode"))).toMatchFileSnapshot(path.join(here, "fixtures", "opencode-acp-v1.activity.txt"));
});

test("an opencode bash call opens with only its cwd, so it carries no command", () => {
  const [call] = toolCallsFromAcpSnapshot("opencode");
  expect(call).toEqual({ runtime: "opencode", tool: "bash", input: JSON.stringify({ cwd: "<cwd>" }) });
  expect(classifyTool(call?.runtime ?? "", call?.tool ?? "", call?.input)).toEqual({ kind: "run_command" });
});

test("ACP shell calls: grok's opening input carries its command and description, kimi's opens with none", () => {
  const classified = (runtime: "grok" | "kimi") =>
    toolCallsFromAcpSnapshot(runtime).map((call) => ({ call, action: classifyTool(call.runtime, call.tool, call.input) }));
  expect({ grok: classified("grok"), kimi: classified("kimi") }).toMatchInlineSnapshot(`
    {
      "grok": [
        {
          "action": {
            "command": "<command>",
            "description": "<description>",
            "detail": "<command>",
            "kind": "run_command",
          },
          "call": {
            "input": "{"command":"<command>","description":"<description>"}",
            "runtime": "grok",
            "tool": "run_terminal_command",
          },
        },
      ],
      "kimi": [
        {
          "action": {
            "kind": "run_command",
          },
          "call": {
            "runtime": "kimi",
            "tool": "Bash",
          },
        },
      ],
    }
  `);
});
