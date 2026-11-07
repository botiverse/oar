import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { initialCodexProjection, foldCodexNotification } from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord, asRecordList, parseJson } from "../../packages/oar/src/shared/json.js";

const here = import.meta.dirname;
const ROOT = "thread-root";

// oxlint-disable-next-line eslint/max-statements -- Replay pins both lifecycle halves and reporting-thread ownership.
test("recorded Codex collaboration waits have tool lifecycles on their reporting thread", () => {
  const lines = readFileSync(path.join(here, "fixtures", "codex-peers.raw.jsonl"), "utf8").trim().split("\n");
  let state = initialCodexProjection(ROOT);
  const calls: string[] = [];
  for (const line of lines) {
    const frame = asRecord(parseJson(line)) ?? {};
    const folded = foldCodexNotification(state, String(frame.method), frame);
    ({ state } = folded);
    for (const command of folded.commands) {
      for (const event of command.kind === "frame" ? command.body.events : []) {
        if (event.kind === "tool_call_started") {
          expect(event.tool).toBe("collabAgentToolCall");
          expect(event.input).toBe('{"tool":"wait"}');
          calls.push(`${(command.kind === "frame" ? command.sessionId : undefined) ?? ROOT}:start:${event.callId}`);
        } else if (event.kind === "tool_call_ended") {
          expect(event.result).toBe("ok");
          calls.push(`${(command.kind === "frame" ? command.sessionId : undefined) ?? ROOT}:end:${event.callId}`);
        }
      }
    }
  }
  expect(calls).toEqual([
    "thread-root:start:call_8hfpQJWtuie0IH2QMdc2r1Vo",
    "thread-beta:start:call_ivTt1fySHN8JCDEEmDczT26K",
    "thread-beta:end:call_ivTt1fySHN8JCDEEmDczT26K",
    "thread-root:end:call_8hfpQJWtuie0IH2QMdc2r1Vo",
    "thread-alpha:start:call_Vmf0n5shK0pzzQTIkf9cL9uH",
    "thread-alpha:end:call_Vmf0n5shK0pzzQTIkf9cL9uH",
    "thread-root:start:call_L7k80TOuNq8Z2dMnTo4y2I7v",
    "thread-root:end:call_L7k80TOuNq8Z2dMnTo4y2I7v",
  ]);
});


test("actual wait_agent items preserve the native operation and explicit null prompt", () => {
  const text = readFileSync(path.join(here, "../../experiments/tool-activity-audit/results/collaboration.json"), "utf8");
  const recording = asRecord(parseJson(text));
  const [frame] = asRecordList(recording?.frames);
  expect(frame).toBeDefined();
  const projected = foldCodexNotification(initialCodexProjection(ROOT), "item/started", { threadId: ROOT, item: frame?.item });
  expect(projected.commands.flatMap(command => command.kind === "frame" ? command.body.events : [])).toEqual([
    { kind: "tool_call_started", tool: "collabAgentToolCall", callId: "audit_wait", input: '{"tool":"wait","prompt":null}' },
  ]);
});
