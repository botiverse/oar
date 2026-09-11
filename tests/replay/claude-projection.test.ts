import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  claudePrompted,
  foldClaudeStdout,
  initialClaudeProjection,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Record/replay: fold a REAL recorded claude stdout stream (fixtures/*.raw.jsonl,
 * captured from a live login by `pnpm sea-trial:record`, scrubbed to consumed
 * fields) through the production projection fold and snapshot the result as a
 * FILE beside the input — input is a file, so the output is too. The snapshot
 * shows each raw frame next to the record(s) it produced: the living
 * "what the provider sends → how we project it" specimen and a regression net.
 * Every frame yields exactly one event (v2: nothing is dropped); the views
 * column is what oar read out of it.
 */

const here = import.meta.dirname;
const scenarios = ["tool-round", "multi-turn", "steer", "error"];

function describeCommand(command: ProjectionCommand): string {
  switch (command.kind) {
    case "respond":
      return `respond ${command.requestId} ${command.body.kind}`;
    case "toApp":
      return `toApp ${command.type}`;
    case "event": {
      const at = command.agentPath.length === 0 ? "" : ` @${command.agentPath.join("/")}`;
      const views = command.body.views.map((view) => {
        switch (view.kind) {
          case "tool_call_started":
            return `tool_call_started ${view.tool}`;
          case "reasoning":
            return `reasoning ${view.content.kind}`;
          case "turn_ended":
            return `turn_ended ${view.outcome.kind}`;
          case "text_delta":
          case "tool_call_ended":
          case "usage":
          case "model":
            return view.kind;
          default:
            return "?";
        }
      });
      return `event${at}${views.length === 0 ? "" : ` → ${views.join(", ")}`}`;
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
      const produced = commands.map((command) => describeCommand(command)).join(", ") || "—";
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
      if (command.kind === "event") {
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
      if (command.kind === "event") {
        const usage = command.body.views.find((view) => view.kind === "usage");
        totals.push(`${command.agentPath.join("/") || "root"}:${JSON.stringify(usage?.kind === "usage" ? usage.usage.tokens : null)}`);
      }
    }
  }
  return totals;
}

test("claude result usage accumulates per agent into cumulative totals", () => {
  expect(usageTotals([resultFrame(null, 10, 1), resultFrame(null, 20, 2), resultFrame("task-9", 5, 5)])).toEqual([
    'root:{"input":10,"output":1}',
    'root:{"input":30,"output":3}',
    'task-9:{"input":5,"output":5}',
  ]);
});
