import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  claudePrompted,
  foldClaudeStdout,
  initialClaudeProjection,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/claude/projection.js";
import type { TokenTotals } from "../../packages/oar/src/contracts/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Record/replay: fold a REAL recorded claude stdout stream (fixtures/*.raw.jsonl,
 * captured from a live login by `pnpm sea-trial:record`, scrubbed to consumed
 * fields) through the production projection fold and snapshot the result as a
 * FILE beside the input: input is a file, so the output is too. The snapshot
 * shows each raw frame next to the record(s) it produced: the living
 * "what the provider sends → how we project it" specimen and a regression net.
 * Every frame yields exactly one event (nothing is dropped); the events
 * column is what oar read out of it.
 */

const here = import.meta.dirname;
const scenarios = ["tool-round", "multi-turn", "steer", "error", "background-tasks", "mcp-echo"];

function describeUsage(tokens: TokenTotals | undefined): string {
  if (tokens === undefined) {
    return "usage";
  }
  const parts = [
    ...(tokens.cacheRead === undefined ? [] : [` cacheRead=${String(tokens.cacheRead)}`]),
    ...(tokens.cacheWrite === undefined ? [] : [` cacheWrite=${String(tokens.cacheWrite)}`]),
  ];
  return `usage in=${String(tokens.input)} out=${String(tokens.output)}${parts.join("")}`;
}

function describeCommand(command: ProjectionCommand): string {
  switch (command.kind) {
    case "respond":
      return `respond ${command.requestId} ${command.body.kind}`;
    case "toApp":
      return `toApp ${command.type}`;
    case "frame": {
      const at = command.agentPath.length === 0 ? "" : ` @${command.agentPath.join("/")}`;
      const events = command.body.events.map((view) => {
        switch (view.kind) {
          case "tool_call_started":
            return `tool_call_started ${view.tool}`;
          case "reasoning":
            return `reasoning ${view.content.kind}`;
          case "turn_ended":
            return `turn_ended ${view.outcome.kind}`;
          case "usage":
            return describeUsage(view.usage.tokens);
          case "text_delta":
          case "tool_call_ended":
          case "service_tier":
          case "input_dropped":
          case "user_message":
          case "model":
          case "effort":
          case "tool_call_progress":
          case "tool_call_input":
          case "compaction_started":
          case "compaction_ended":
          case "retry":
          case "task_started":
          case "task_updated":
          case "task_ended":
            return view.kind;
          default:
            return "?";
        }
      });
      return `event${at}${events.length === 0 ? "" : ` → ${events.join(", ")}`}`;
    }
    default:
      return "?";
  }
}

function summarizeFrame(message: { type?: string; subtype?: string; message?: { content?: { type?: string }[] } }): string {
  const blocks = message.message?.content?.map((block) => block.type).join(",") ?? "";
  return [message.type, message.subtype, blocks].filter((part) => part !== undefined && part !== "").join(" ");
}

function foldFixture(lines: readonly string[]): string {
  // Seed as if a prompt opened the first turn (the control-plane input the
  // recorded stdout stream does not itself carry).
  let state = claudePrompted(initialClaudeProjection);
  const rows: string[] = [];
  for (const line of lines) {
    const message = asRecord(parseJson(line));
    if (message !== null) {
      const { state: next, commands } = foldClaudeStdout(state, message);
      state = next;
      const produced = commands.map((command) => describeCommand(command)).join(", ") || "-";
      rows.push(`${summarizeFrame(message).padEnd(28)} │ ${produced}`);
    }
  }
  return `${rows.join("\n")}\n`;
}

for (const scenario of scenarios) {
  test(`claude ${scenario}: recorded stdout folds to the expected records`, async () => {
    const lines = readFileSync(path.join(here, "fixtures", `claude-${scenario}.raw.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    await expect(foldFixture(lines)).toMatchFileSnapshot(
      path.join(here, "fixtures", `claude-${scenario}.projected.txt`),
    );
  });
}

test("claude sub-agent frames attribute to the Task call that spawned them, nested", () => {
  const frames = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "task-1", name: "Task", input: {} }] } },
    { type: "assistant", parent_tool_use_id: "task-1", message: { content: [{ type: "text", text: "child" }, { type: "tool_use", id: "task-2", name: "Task", input: {} }] } },
    { type: "assistant", parent_tool_use_id: "task-2", message: { content: [{ type: "text", text: "grandchild" }] } },
    { type: "user", parent_tool_use_id: "task-1", message: { content: [{ type: "tool_result", tool_use_id: "task-2", content: "done" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "root again" }] } },
  ];
  let state = claudePrompted(initialClaudeProjection);
  const paths: string[] = [];
  for (const frame of frames) {
    const { state: next, commands } = foldClaudeStdout(state, frame);
    state = next;
    for (const command of commands) {
      if (command.kind === "frame") {
        paths.push(command.agentPath.join("/") || "root");
      }
    }
  }
  expect(paths).toEqual(["root", "task-1", "task-1/task-2", "task-1", "root"]);
});

const resultFrame = (agent: string | null, input: number, output: number): Record<string, unknown> => ({
  type: "result", subtype: "success", is_error: false,
  ...(agent === null ? {} : { parent_tool_use_id: agent }),
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

function usageTotals(frames: readonly Record<string, unknown>[]): string[] {
  let state = claudePrompted(initialClaudeProjection);
  const totals: string[] = [];
  for (const frame of frames) {
    const { state: next, commands } = foldClaudeStdout(state, frame);
    state = next;
    for (const command of commands) {
      if (command.kind === "frame") {
        const usage = command.body.events.find((view) => view.kind === "usage");
        totals.push(`${command.agentPath.join("/") || "root"}:${JSON.stringify(usage?.kind === "usage" ? usage.usage.tokens : null)}`);
      }
    }
  }
  return totals;
}

test("claude result usage accumulates per agent into cumulative totals", () => {
  expect(usageTotals([resultFrame(null, 10, 1), resultFrame(null, 20, 2), resultFrame("task-9", 5, 5)])).toEqual([
    'root:{"input":10,"output":1,"cacheRead":0,"cacheWrite":0}',
    'root:{"input":30,"output":3,"cacheRead":0,"cacheWrite":0}',
    'task-9:{"input":5,"output":5,"cacheRead":0,"cacheWrite":0}',
  ]);
});

/** The `result` frame of the recorded background-tasks turn (fixtures/claude-background-tasks.raw.jsonl, a live login). */
function recordedResult(): Record<string, unknown> {
  const line = readFileSync(path.join(here, "fixtures", "claude-background-tasks.raw.jsonl"), "utf8")
    .split("\n")
    .find((candidate) => asRecord(parseJson(candidate))?.type === "result");
  const frame = asRecord(parseJson(line ?? ""));
  expect(frame?.usage).toEqual({ input_tokens: 4, output_tokens: 359, cache_read_input_tokens: 29_198, cache_creation_input_tokens: 9807 });
  return frame ?? {};
}

// #161: `cache_read_input_tokens` and `cache_creation_input_tokens` are parts
// of input (input_tokens excludes them), each accumulated like input. A
// result without them adds nothing to the parts, which stay; an agent whose
// results never carried them has neither.
test("claude cache reads and writes accumulate per agent across turns as parts of input", () => {
  const recorded = recordedResult();
  const bare = { type: "result", subtype: "success", usage: { input_tokens: 7, output_tokens: 3 } };
  expect(usageTotals([recorded, recorded, bare, { ...bare, parent_tool_use_id: "task-9" }])).toEqual([
    'root:{"input":39009,"output":359,"cacheRead":29198,"cacheWrite":9807}',
    'root:{"input":78018,"output":718,"cacheRead":58396,"cacheWrite":19614}',
    'root:{"input":78025,"output":721,"cacheRead":58396,"cacheWrite":19614}',
    'task-9:{"input":7,"output":3}',
  ]);
});

// The Messages API's `is_error` is optional and false by default; claude
// 2.1.288 omits it on a successful Read, Write or Edit (Ferry's log, 2026-10-03).
test("claude tool_result is failed on is_error true and ok otherwise, the field's default", () => {
  const failed = foldClaudeStdout(claudePrompted(initialClaudeProjection), {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "c-fail", is_error: true, content: "nope" }] },
  });
  expect(failed.commands[0]?.kind === "frame" ? failed.commands[0].body.events : null).toEqual([
    { kind: "tool_call_ended", callId: "c-fail", content: [{ type: "text", text: "nope" }], result: "failed" },
  ]);
  const absent = foldClaudeStdout(failed.state, {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "c-write", content: "File created successfully at: /tmp/a.js" }] },
  });
  expect(absent.commands[0]?.kind === "frame" ? absent.commands[0].body.events : null).toEqual([
    { kind: "tool_call_ended", callId: "c-write", content: [{ type: "text", text: "File created successfully at: /tmp/a.js" }], result: "ok" },
  ]);
});

function endedEvents(content: unknown): unknown {
  const { commands } = foldClaudeStdout(claudePrompted(initialClaudeProjection), {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "c", content }] },
  });
  return commands[0]?.kind === "frame" ? commands[0].body.events : null;
}

test("claude tool_result: a string is one text part, blocks are ordered parts, unknown blocks are kept whole (#73)", () => {
  // `Read` of a png on 2.1.288: the result is one Anthropic image block.
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" } };
  expect(endedEvents([png])).toEqual([{ kind: "tool_call_ended", callId: "c", content: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo" }], result: "ok" }]);
  // An MCP tool's image arrives in the MCP shape between texts; order is kept.
  const mcp = [{ type: "text", text: "before" }, { type: "image", data: "R0lGOD", mimeType: "image/gif" }, { type: "text", text: "after" }];
  expect(endedEvents(mcp)).toEqual([{ kind: "tool_call_ended", callId: "c", content: [
    { type: "text", text: "before" }, { type: "image", mediaType: "image/gif", data: "R0lGOD" }, { type: "text", text: "after" },
  ], result: "ok" }]);
  const reference = { type: "tool_reference", tool_name: "x" };
  expect(endedEvents([reference])).toEqual([{ kind: "tool_call_ended", callId: "c", content: [{ type: "other", value: reference }], result: "ok" }]);
  expect(endedEvents([])).toEqual([{ kind: "tool_call_ended", callId: "c", result: "ok" }]);
});

test("claude compact_boundary is the runtime's after-the-fact compaction report", () => {
  const { commands } = foldClaudeStdout(claudePrompted(initialClaudeProjection), {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: 120_000 },
    session_id: "s",
    uuid: "u",
  });
  expect(commands.map((command) => (command.kind === "frame" ? command.body.events : command.kind))).toMatchInlineSnapshot(`
    [
      [
        {
          "kind": "compaction_ended",
          "outcome": "completed",
          "trigger": "manual",
        },
      ],
    ]
  `);
});

function assistantEvents(message: Record<string, unknown>): unknown {
  const [command] = foldClaudeStdout(claudePrompted(initialClaudeProjection), { type: "assistant", message }).commands;
  return command?.kind === "frame" ? command.body.events : null;
}

test("claude assistant text names its API message id as the text's messageId", () => {
  expect(assistantEvents({ id: "msg_01", role: "assistant", content: [{ type: "text", text: "first" }, { type: "tool_use", id: "c1", name: "Read", input: {} }] })).toEqual([
    { kind: "text_delta", text: "first", messageId: "msg_01" },
    { kind: "tool_call_started", callId: "c1", tool: "Read", input: "{}" },
  ]);
  expect(assistantEvents({ content: [{ type: "text", text: "no id" }] })).toEqual([{ kind: "text_delta", text: "no id" }]);
});

// claude 2.1.292 names a failed turn's cause on its synthetic assistant frame
// (`error`) and the result's `api_error_status` (docs/spec/runtime-matrix.md#claude).
test("a failed result takes the class of the turn's error frame, which the next turn forgets", () => {
  const outcomes: unknown[] = [];
  let state = claudePrompted(initialClaudeProjection);
  for (const frame of [
    { type: "assistant", error: "authentication_failed", message: { model: "<synthetic>", content: [{ type: "text", text: "Invalid API key · Fix external API key" }] } },
    { type: "result", subtype: "success", is_error: true, api_error_status: 401, terminal_reason: "api_error", result: "Invalid API key · Fix external API key" },
    { type: "result", subtype: "success", is_error: true, api_error_status: 529, terminal_reason: "api_error", result: "API Error: 529 Overloaded." },
  ]) {
    const { state: next, commands } = foldClaudeStdout(state, frame);
    state = next;
    for (const command of commands) {
      const ended = command.kind === "frame" ? command.body.events.find((view) => view.kind === "turn_ended") : undefined;
      if (ended?.kind === "turn_ended") { outcomes.push(ended.outcome); }
    }
  }
  expect(outcomes).toEqual([
    { kind: "failed", reason: "Invalid API key · Fix external API key", failure: "auth", credential: "rejected", status: 401 },
    { kind: "failed", reason: "API Error: 529 Overloaded.", failure: "overloaded", status: 529 },
  ]);
});
