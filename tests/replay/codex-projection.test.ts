import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  foldCodexNotification,
  initialCodexProjection,
  type CodexProjectionState,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Record/replay for codex — same shape as the claude test. A REAL recorded
 * codex notification stream (fixtures/*.raw.jsonl from `pnpm sea-trial:record
 * codex ...`, scrubbed to consumed fields) folds through the production
 * projection; the frame|records table snapshots to a FILE beside the input.
 * Every notification yields exactly one event (v2: nothing is dropped); the
 * views column is what oar read out of it.
 */

const here = import.meta.dirname;
const scenarios = ["tool-round"];
const ROOT = "thread-root";

function describeCommand(command: ProjectionCommand): string {
  switch (command.kind) {
    case "link":
      return `link ${command.edge.parent} → ${command.edge.child} (${command.edge.via})`;
    case "event": {
      const where = command.sessionId === undefined ? "" : ` @thread:${command.sessionId}`;
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
      return `event${where}${views.length === 0 ? "" : ` → ${views.join(", ")}`}`;
    }
    default:
      return "?";
  }
}

function foldLine(state: CodexProjectionState, line: string): { state: CodexProjectionState; row: string | null } {
  const frame = asRecord(parseJson(line));
  const method = typeof frame?.method === "string" ? frame.method : null;
  if (frame === null || method === null) {
    return { state, row: null };
  }
  const { state: next, commands } = foldCodexNotification(state, method, frame);
  const produced = commands.map((command) => describeCommand(command)).join(", ") || "—";
  return { state: next, row: `${method.padEnd(28)} │ ${produced}` };
}

function foldFixture(lines: readonly string[]): string {
  let state: CodexProjectionState = initialCodexProjection(ROOT);
  const rows: string[] = [];
  for (const line of lines) {
    const { state: next, row } = foldLine(state, line);
    state = next;
    if (row !== null) {
      rows.push(row);
    }
  }
  return `${rows.join("\n")}\n`;
}

for (const scenario of scenarios) {
  test(`codex ${scenario}: recorded notifications fold to the expected records`, async () => {
    const lines = readFileSync(path.join(here, "fixtures", `codex-${scenario}.raw.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    await expect(foldFixture(lines)).toMatchFileSnapshot(
      path.join(here, "fixtures", `codex-${scenario}.projected.txt`),
    );
  });
}

const CHILD_FRAMES: readonly { method: string; params: Record<string, unknown> }[] = [
  { method: "item/started", params: { threadId: ROOT, turnId: "t1", item: { type: "collabAgentToolCall", id: "c1", senderThreadId: ROOT, receiverThreadIds: ["thread-child"] } } },
  { method: "turn/started", params: { threadId: "thread-child", turn: { id: "t-child" } } },
  { method: "item/agentMessage/delta", params: { threadId: "thread-child", turnId: "t-child", delta: "hi" } },
  { method: "item/completed", params: { threadId: ROOT, turnId: "t1", item: { type: "subAgentActivity", id: "s1", agentThreadId: "thread-child" } } },
];

function foldFrames(frames: readonly { method: string; params: Record<string, unknown> }[]): string[] {
  let state = initialCodexProjection(ROOT);
  const rows: string[] = [];
  for (const frame of frames) {
    const { state: next, commands } = foldCodexNotification(state, frame.method, frame.params);
    state = next;
    rows.push(commands.map((command) => describeCommand(command)).join(", "));
  }
  return rows;
}

test("codex notifications of another thread are child-session records; collab items link them", () => {
  expect(foldFrames(CHILD_FRAMES)).toEqual([
    "event, link thread-root → thread-child (tool_call)",
    "event @thread:thread-child",
    "event @thread:thread-child → text_delta",
    "event, link thread-root → thread-child (tool_call)",
  ]);
  const { commands } = foldCodexNotification(initialCodexProjection(ROOT), "item/agentMessage/delta", { threadId: "thread-child", turnId: "t-child", delta: "x" });
  const [event] = commands;
  expect(event?.kind === "event" ? event.spanId : null).toBe("t-child");
});

test("codex error detail folds into the failed turn_ended and usage is the cumulative total", () => {
  let state = initialCodexProjection(ROOT);
  const errored = foldCodexNotification(state, "error", { threadId: ROOT, error: { message: "boom", additionalDetails: "quota" } });
  ({ state } = errored);
  const completed = foldCodexNotification(state, "turn/completed", { threadId: ROOT, turn: { id: "t1", status: "failed" } });
  const [end] = completed.commands;
  expect(end?.kind === "event" ? end.body.views : null).toEqual([
    { kind: "turn_ended", outcome: { kind: "failed", reason: "failed: boom — quota", failure: "quota" } },
  ]);
  expect(completed.state.lastErrorDetail).toBeNull();
  const usage = foldCodexNotification(state, "thread/tokenUsage/updated", { threadId: ROOT, tokenUsage: { total: { inputTokens: 120, outputTokens: 30 } } });
  const { commands: [record] } = usage;
  expect(record?.kind === "event" ? record.body.views : null).toEqual([
    { kind: "usage", usage: { context: { tokens: 120, contextWindow: null, percent: null }, tokens: { input: 120, output: 30 } } },
  ]);
});
