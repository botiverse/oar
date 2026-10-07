import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { Frame } from "../../packages/oar/src/contracts/session.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { classifyTool, toolActionLabel } from "../../packages/oar/src/observe/tool-activity.js";
import { codexItemInput } from "../../packages/oar/src/runtimes/codex/item-detail.js";
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
      // As the projection hands it on (codex/item-detail.ts): commandExecution's input is the
      // bare command line, fileChange's its `changes` array as JSON.
      const input = codexItemInput(item);
      calls.push(input === undefined ? { runtime: "codex", tool: item.type } : { runtime: "codex", tool: item.type, input });
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

/** A call's tool part in the session view (its `input` the latest reported), with the input it started with. */
interface AcpCall extends ToolCall { started?: string }

/**
 * The ACP vendor snapshots (experiments/acp-vendor-snapshot.ts) keep each tool frame's
 * `title`, `kind`, `status` and the KEYS of its `rawInput`, not their values. The frames run
 * through the ACP projection, each opening `tool_call` starting the next call, so a call starts
 * where `tool_call_started` really does, and the records fold into the session view, whose
 * tool part takes each later `tool_call_input`. Each recorded key holds its own name in
 * brackets: what a field is read from, never a value the runtime did not send. An empty key
 * list is an empty `rawInput`; no list, no `rawInput`.
 */
function acpCallsFromSnapshot(runtime: "grok" | "kimi" | "opencode", name = `${runtime}-acp-v1`): AcpCall[] {
  const text = readFileSync(path.join(here, "fixtures", `${name}.vendor.json`), "utf8");
  const snapshot = asRecord(parseJson(text));
  const frames: unknown = asRecord(snapshot?.prompt)?.tools;
  const state = createAcpProjectionState();
  const started = new Map<string, string | undefined>();
  let opened = 0;
  const records = (Array.isArray(frames) ? frames : []).map((raw: unknown, seq): Frame => {
    const { sessionUpdate, title, kind, status, rawInputKeys } = asRecord(raw) ?? {};
    if (sessionUpdate === "tool_call") {
      opened += 1;
    }
    const keys = Array.isArray(rawInputKeys) ? rawInputKeys.filter((key): key is string => typeof key === "string") : null;
    const events = projectAcpUpdate(state, {
      toolCallId: `recorded-${String(opened)}`,
      sessionUpdate,
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
      ...(keys === null ? {} : { rawInput: Object.fromEntries(keys.map((key) => [key, `<${key}>`])) }),
    });
    for (const event of events) {
      if (event.kind === "tool_call_started") {
        started.set(event.callId, event.input);
      }
    }
    return { sessionId: "recorded", agentPath: [], seq, receivedAt: 0, kind: "frame", body: { type: String(sessionUpdate), native: raw, events } };
  });
  return viewOf(records).messages
    .flatMap((message) => (message.kind === "turn" ? message.sections.flatMap((section) => section.parts) : []))
    .flatMap((part): AcpCall[] => {
      if (part.kind !== "tool") {
        return [];
      }
      const input = started.get(part.callId);
      return [{
        runtime,
        tool: part.tool,
        ...(input === undefined ? {} : { started: input }),
        ...(part.input === undefined ? {} : { input: part.input }),
      }];
    });
}

function toolCallsFromAcpSnapshot(runtime: "grok" | "kimi" | "opencode", name?: string): ToolCall[] {
  return acpCallsFromSnapshot(runtime, name).map(({ started: _started, ...call }) => call);
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

for (const scenario of ["tool-round", "file-change"]) {
  test(`codex ${scenario} tool calls render as friendly activity`, async () => {
    const lines = fixture(`codex-${scenario}.raw.jsonl`);
    await expect(render(toolCallsFromCodex(lines))).toMatchFileSnapshot(path.join(here, "fixtures", `codex-${scenario}.activity.txt`));
  });
}

test("a codex fileChange names each changed path and a rename's target, as recorded", () => {
  // codex 0.160.1 against aimock (`pnpm sea-trial:record codex-aimock file-change`): one patch
  // updating notes.txt, adding added.txt, deleting gone.txt and moving old-name.txt to new-name.txt.
  const [call, ...rest] = toolCallsFromCodex(fixture("codex-file-change.raw.jsonl"));
  expect(rest).toEqual([]);
  expect(classifyTool(call?.runtime ?? "", call?.tool ?? "", call?.input)).toMatchInlineSnapshot(`
    {
      "detail": "<cwd>/added.txt",
      "kind": "edit_file",
      "paths": [
        "<cwd>/added.txt",
        "<cwd>/gone.txt",
        "<cwd>/notes.txt",
        "<cwd>/old-name.txt",
        "<cwd>/new-name.txt",
      ],
    }
  `);
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

test("opencode file tools render as friendly activity", async () => {
  await expect(render(toolCallsFromAcpSnapshot("opencode", "opencode-acp-v1-files"))).toMatchFileSnapshot(path.join(here, "fixtures", "opencode-acp-v1-files.activity.txt"));
});

test("an opencode bash call opens with only its cwd; its command arrives as the call's input", () => {
  const [call] = acpCallsFromSnapshot("opencode");
  expect(call).toEqual({ runtime: "opencode", tool: "bash", started: JSON.stringify({ cwd: "<cwd>" }), input: JSON.stringify({ command: "<command>", cwd: "<cwd>" }) });
  expect(classifyTool(call?.runtime ?? "", call?.tool ?? "", call?.started)).toEqual({ kind: "run_command" });
  expect(classifyTool(call?.runtime ?? "", call?.tool ?? "", call?.input)).toEqual({ kind: "run_command", detail: "<command>", command: "<command>" });
});

test("ACP shell calls: grok's opening input carries its command and description, kimi's command arrives later", () => {
  const classified = (runtime: "grok" | "kimi") =>
    acpCallsFromSnapshot(runtime).map((call) => ({ call, action: classifyTool(call.runtime, call.tool, call.input) }));
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
            "input": "{"command":"<command>","description":"<description>","is_background":"<is_background>","variant":"<variant>"}",
            "runtime": "grok",
            "started": "{"command":"<command>","description":"<description>"}",
            "tool": "run_terminal_command",
          },
        },
      ],
      "kimi": [
        {
          "action": {
            "command": "<command>",
            "detail": "<command>",
            "kind": "run_command",
          },
          "call": {
            "input": "{"command":"<command>"}",
            "runtime": "kimi",
            "tool": "Bash",
          },
        },
      ],
    }
  `);
});

test("opencode file tools: each opens with an empty input, and the latest names the file or the search", () => {
  const lines = acpCallsFromSnapshot("opencode", "opencode-acp-v1-files")
    .map((call) => `${call.tool} ${call.started ?? "-"} → ${call.input ?? "-"} ⇒ ${JSON.stringify(classifyTool(call.runtime, call.tool, call.input))}`);
  expect(lines).toMatchInlineSnapshot(`
    [
      "write {} → {"content":"<content>","filePath":"<filePath>"} ⇒ {"kind":"edit_file","detail":"<filePath>","paths":["<filePath>"]}",
      "read {} → {"filePath":"<filePath>"} ⇒ {"kind":"read_file","detail":"<filePath>","paths":["<filePath>"]}",
      "edit {} → {"filePath":"<filePath>","newString":"<newString>","oldString":"<oldString>"} ⇒ {"kind":"edit_file","detail":"<filePath>","paths":["<filePath>"]}",
      "grep {} → {"path":"<path>","pattern":"<pattern>"} ⇒ {"kind":"search","detail":"<path>"}",
      "glob {} → {"path":"<path>","pattern":"<pattern>"} ⇒ {"kind":"search","detail":"<path>"}",
      "bash {"cwd":"<cwd>"} → {"command":"<command>","workdir":"<workdir>"} ⇒ {"kind":"run_command","detail":"<command>","command":"<command>"}",
    ]
  `);
});
