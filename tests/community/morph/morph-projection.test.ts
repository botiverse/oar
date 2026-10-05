import { expect, test } from "vitest";
import type { RuntimeEventBody } from "../../../packages/oar/src/contracts/session.js";
import {
  foldMorphStream,
  foldMorphTask,
  initialMorphProjection,
  morphContextEvents,
  type MorphProjection,
} from "../../../packages/oar/src/community/morph/projection.js";
import { projectMorphModels } from "../../../packages/oar/src/community/morph/list-models.js";

// Shapes as morph Console answered experiments/morph-runtime-probe.ts on
// 2026-10-04 (profile codex), trimmed to the fields OAR reads.
const TASK = "console_1_6";
const entry = (seq: number, event: Record<string, unknown>): Record<string, unknown> => ({ seq, at: "2026-10-04T08:40:12+09:00", event: { run_id: TASK, ...event } });
const turnStart = entry(1, { kind: "turn_start", model: "gpt-5.6-luna", activity_id: "turn", status: "running" });
const llmStart = entry(2, { kind: "llm_start", model: "gpt-5.6-luna", status: "running" });
const llmDone = entry(3, { kind: "llm_done", model: "gpt-5.6-luna", status: "done" });
const toolStart = entry(4, { kind: "tool_start", activity_id: "call_Iddq", tool_name: "bash", status: "running", args: { cmd: "echo oar-probe" } });
const toolOutput = entry(5, { kind: "tool_output", tool_name: "bash", status: "running", profile: "long_shell", stream: "stdout", text: "oar-probe\n" });
const toolDone = entry(6, { kind: "tool_done", activity_id: "call_Iddq", tool_name: "bash", status: "done", text: "exit_code: 0\nstdout_truncated: false\nstderr_truncated: false\nstdout:\noar-probe\n\n\nstderr:\n", args: { cmd: "echo oar-probe" } });
const turnDone = entry(9, { kind: "turn_done", activity_id: "turn", status: "done", text: "done" });

function replay(frames: readonly unknown[], fold: (state: MorphProjection, frame: unknown) => { state: MorphProjection; events: readonly RuntimeEventBody[] } = foldMorphStream): { state: MorphProjection; events: RuntimeEventBody[] } {
  let state = initialMorphProjection;
  const events: RuntimeEventBody[] = [];
  for (const frame of frames) {
    const next = fold(state, frame);
    ({ state } = next);
    events.push(...next.events);
  }
  return { state, events };
}

const toolTurn: readonly unknown[] = [
  { task_id: TASK, seq: 61, status: "running" },
  { task_id: TASK, seq: 62, status: "running", trace: { entries: [turnStart] } },
  { task_id: TASK, seq: 63, status: "running", trace: { entries: [turnStart, llmStart] } },
  { task_id: TASK, seq: 64, status: "running", reasoning: "**Executing bash**", trace: { entries: [turnStart, llmStart] } },
  { task_id: TASK, seq: 66, status: "running", reasoning: "**Executing bash**", trace: { entries: [llmStart, llmDone, toolStart] } },
  { task_id: TASK, seq: 70, status: "running", text: "[bash] running\n\nstdout:\noar-probe", preview: true, reasoning: "**Executing bash**", trace: { entries: [llmDone, toolStart, toolOutput] } },
  { task_id: TASK, seq: 71, status: "running", text: "[bash] done\n\nstdout:\noar-probe", preview: true, reasoning: "**Executing bash**", trace: { entries: [toolStart, toolOutput, toolDone] } },
  { task_id: TASK, seq: 75, status: "running", text: "do", reasoning: "**Executing bash**\n\n**Confirming**", trace: { entries: [toolOutput, toolDone] } },
  { task_id: TASK, seq: 79, status: "done", text: "done", done: true, trace: { entries: [toolDone, turnDone] } },
];

// oxlint-disable-next-line eslint/max-lines-per-function -- the inline snapshot pins one whole turn's events.
test("a tool turn's snapshots read each trace entry once and model text only from non-preview snapshots", () => {
  const { state, events } = replay(toolTurn);
  expect(events).toMatchInlineSnapshot(`
    [
      {
        "kind": "model",
        "model": "gpt-5.6-luna",
      },
      {
        "content": {
          "kind": "text",
          "text": "**Executing bash**",
        },
        "kind": "reasoning",
      },
      {
        "callId": "call_Iddq",
        "input": "echo oar-probe",
        "kind": "tool_call_started",
        "tool": "bash",
      },
      {
        "callId": "call_Iddq",
        "kind": "tool_call_progress",
        "output": "oar-probe
    ",
      },
      {
        "callId": "call_Iddq",
        "content": [
          {
            "text": "exit_code: 0
    stdout_truncated: false
    stderr_truncated: false
    stdout:
    oar-probe


    stderr:
    ",
            "type": "text",
          },
        ],
        "exitCode": 0,
        "kind": "tool_call_ended",
        "result": "ok",
      },
      {
        "content": {
          "kind": "text",
          "text": "

    **Confirming**",
        },
        "kind": "reasoning",
      },
      {
        "kind": "text_delta",
        "messageId": "console_1_6:0",
        "text": "do",
      },
      {
        "kind": "text_delta",
        "messageId": "console_1_6:0",
        "text": "ne",
      },
    ]
  `);
  expect(state.tasks[TASK]?.traceSeq).toBe(9);
});

test("the terminal task answer fills what the stream missed, then ends the turn", () => {
  const streamed = replay([{ task_id: TASK, seq: 62, status: "running", text: "do", trace: { entries: [turnStart, llmStart] } }]);
  const final = foldMorphTask(streamed.state, {
    id: TASK,
    status: "done",
    model: "gpt-5.6-luna",
    result: { final: { output: "done" }, metrics: { total_tokens: 9666 }, trace: { entries: [turnStart, llmStart, llmDone, toolStart, toolDone, turnDone] } },
  });
  expect(final.events.map((event) => event.kind)).toEqual(["tool_call_started", "tool_call_ended", "text_delta", "turn_ended"]);
  expect(final.events.at(-2)).toEqual({ kind: "text_delta", text: "ne", messageId: `${TASK}:0` });
  expect(final.state.tasks[TASK]).toBeUndefined();
});

test("turn outcomes: canceled is aborted, failed carries morph's error classified", () => {
  const end = (info: Record<string, unknown>): unknown => foldMorphTask(initialMorphProjection, { id: TASK, ...info }).events.at(-1);
  expect(end({ status: "canceled", error: "stopped by user" })).toEqual({ kind: "turn_ended", outcome: { kind: "aborted" } });
  expect(end({ status: "failed", error: "llm call failed at step 0: 429 rate limit" })).toEqual({
    kind: "turn_ended",
    outcome: { kind: "failed", reason: "llm call failed at step 0: 429 rate limit", failure: "quota" },
  });
  expect(foldMorphTask(initialMorphProjection, { id: TASK, status: "running" }).events).toEqual([]);
  expect(foldMorphTask(initialMorphProjection, { id: TASK, status: "pending" }).events).toEqual([]);
});

test("a canceled or failed task's error text is never the agent's reply", () => {
  // As observed 2026-10-04: the stopped task's last snapshots and its answer carry the error as text.
  const streamed = replay([
    { task_id: TASK, seq: 7, status: "failed", text: "stopped by user", error: "stopped by user", done: true },
    { task_id: TASK, seq: 8, status: "canceled", text: "stopped by user" },
  ]);
  expect(streamed.events).toEqual([]);
  const ended = foldMorphTask(streamed.state, { id: TASK, status: "canceled", error: "stopped by user", result: { final: { output: "stopped by user" } } });
  expect(ended.events).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
  const failed = foldMorphTask(initialMorphProjection, { id: TASK, status: "failed", error: "llm call failed", result: { final: { output: "llm call failed" } } });
  expect(failed.events.map((event) => event.kind)).toEqual(["turn_ended"]);
});

test("steer, retry and compaction entries", () => {
  const { events } = replay([{
    task_id: TASK,
    seq: 1,
    status: "running",
    trace: {
      entries: [
        entry(1, { kind: "steer_queued", text: "Also append steered." }),
        entry(2, { kind: "llm_retry", text: "Request failed: Network connection failed. Retrying in 1.0s (1/5)." }),
        entry(3, { kind: "steer_applied", activity_id: "steer", status: "applied", text: "Also append steered.", args: { count: 1 } }),
        entry(4, { kind: "context_compaction_start" }),
        entry(5, { kind: "context_compaction_failed", error: "summary too long" }),
      ],
    },
  }]);
  expect(events).toEqual([
    { kind: "retry", attempt: 1, maxAttempts: 5, delayMs: 1000, reason: "Request failed: Network connection failed. Retrying in 1.0s (1/5)." },
    { kind: "user_message", input: "Also append steered.", evidence: "conversation" },
    { kind: "compaction_started" },
    { kind: "compaction_ended", outcome: "failed", reason: "summary too long" },
  ]);
});

test("a snapshot that rewrites the text starts a new message instead of a wrong delta", () => {
  const { events } = replay([
    { task_id: TASK, seq: 1, text: "Let me check." },
    { task_id: TASK, seq: 2, text: "The answer is 4." },
  ]);
  expect(events).toEqual([
    { kind: "text_delta", text: "Let me check.", messageId: `${TASK}:0` },
    { kind: "text_delta", text: "The answer is 4.", messageId: `${TASK}:1` },
  ]);
});

test("context fullness comes from topic metadata once Console measured it", () => {
  expect(morphContextEvents({ context: { available: false } })).toEqual([]);
  expect(morphContextEvents({ context: { available: true, used_input_tokens: 262_500, context_window_tokens: 1_050_000, usage_ratio: 0.25 } })).toEqual([
    { kind: "usage", usage: { context: { tokens: 262_500, contextWindow: 1_050_000, percent: 25 } } },
  ]);
});

test("LLM profiles are the models, default first, naming the model each resolves to", () => {
  expect(projectMorphModels({
    default: { name: "default", inference_provider: "openai_response_compatible", model: "copilot/claude-sonnet-5.5" },
    items: [{ name: "codex", inference_provider: "openai_codex", model: "gpt-5.6-luna" }, { name: "default" }, { name: "" }],
  })).toEqual([
    { id: "default", resolvedId: "copilot/claude-sonnet-5.5" },
    { id: "codex", resolvedId: "gpt-5.6-luna" },
  ]);
});
