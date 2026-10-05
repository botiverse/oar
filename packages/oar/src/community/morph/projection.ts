import type { RuntimeEventBody, TurnOutcome } from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asNumber, asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";

/*
 * Pure readings of what the morph Console Runtime API says about one task
 * (mistermorph docs/runtime-api.md, observed 2026-10-04 with
 * experiments/morph-runtime-probe.ts):
 *
 * - `/stream/ws` frames are SNAPSHOTS, not deltas: `text` and `reasoning`
 *   are accumulated so far, `trace.entries` is a bounded window of agent
 *   events, each with its own per-task `seq`. A slow reader may miss a
 *   snapshot, so events are read off whatever is new since the last one.
 * - `text` with `preview: true` is Console's tool status line ("[bash]
 *   running\n\nstdout: ..."), not model output; it stays in the native frame.
 * - `GET /tasks/{id}` is authoritative: its terminal status ends the turn,
 *   and its `result` repeats the trace and, for a `done` task, the final
 *   answer, which fills any snapshot the stream skipped.
 */

export interface MorphTaskProjection {
  /** Highest trace entry seq already read. */
  readonly traceSeq: number;
  /** The assistant text read so far for the current message. */
  readonly text: string;
  /** Counts messages, so a rewritten snapshot starts a new `messageId`. */
  readonly message: number;
  readonly reasoning: string;
  /** Tool calls started and not ended, newest last: `tool_output` names only the tool. */
  readonly openCalls: readonly { readonly callId: string; readonly tool: string }[];
}

export interface MorphProjection {
  readonly model: string | null;
  readonly tasks: Readonly<Record<string, MorphTaskProjection>>;
}

export const initialMorphProjection: MorphProjection = { model: null, tasks: {} };

const initialTask: MorphTaskProjection = { traceSeq: 0, text: "", message: 0, reasoning: "", openCalls: [] };

export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "canceled"]);

export interface MorphFold {
  readonly state: MorphProjection;
  readonly events: readonly RuntimeEventBody[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A tool's arguments as one readable line: a lone command string as is, otherwise JSON. */
function describeArgs(args: JsonRecord | null): string | undefined {
  if (args === null || Object.keys(args).length === 0) {
    return undefined;
  }
  const command = args.cmd ?? args.command;
  return typeof command === "string" && Object.keys(args).length === 1 ? command : JSON.stringify(args);
}

/** "Request failed: ... Retrying in 1.0s (1/5)." */
function retryEvent(reason: string): RuntimeEventBody | null {
  const count = /\((\d+)\/(\d+)\)/u.exec(reason);
  if (count === null) {
    return null;
  }
  const delay = /in (\d+(?:\.\d+)?)(ms|s)\b/u.exec(reason);
  return {
    kind: "retry",
    attempt: Number(count[1]),
    maxAttempts: Number(count[2]),
    ...(delay === null ? {} : { delayMs: Math.round(Number(delay[1]) * (delay[2] === "s" ? 1000 : 1)) }),
    reason,
  };
}

function modelEvents(state: MorphProjection, model: unknown): { state: MorphProjection; events: RuntimeEventBody[] } {
  const name = text(model);
  return name === undefined || name === state.model
    ? { state, events: [] }
    : { state: { ...state, model: name }, events: [{ kind: "model", model: name }] };
}

/** One agent event (mistermorph agent/events.go) as OAR events. */
function traceEvent(task: MorphTaskProjection, taskId: string, seq: number, event: JsonRecord): { task: MorphTaskProjection; events: RuntimeEventBody[] } {
  const tool = text(event.tool_name) ?? "tool";
  switch (event.kind) {
    case "tool_start": {
      const callId = text(event.activity_id) ?? `${taskId}:${String(seq)}`;
      const input = describeArgs(asRecord(event.args));
      return {
        task: { ...task, openCalls: [...task.openCalls, { callId, tool }] },
        events: [{ kind: "tool_call_started", callId, tool, ...(input === undefined ? {} : { input }) }],
      };
    }
    case "tool_output": {
      const open = task.openCalls.findLast((call) => call.tool === tool);
      const output = text(event.text);
      return { task, events: open === undefined ? [] : [{ kind: "tool_call_progress", callId: open.callId, ...(output === undefined ? {} : { output }) }] };
    }
    case "tool_done": {
      const callId = text(event.activity_id) ?? task.openCalls.findLast((call) => call.tool === tool)?.callId ?? `${taskId}:${String(seq)}`;
      const output = text(event.text);
      const exit = output === undefined ? null : /^exit_code: (-?\d+)/u.exec(output);
      const failed = text(event.error) !== undefined || event.status === "failed" || event.status === "error";
      const result = failed ? "failed" : (event.status === "done" ? "ok" : undefined);
      return {
        task: { ...task, openCalls: task.openCalls.filter((call) => call.callId !== callId) },
        events: [{
          kind: "tool_call_ended",
          callId,
          ...(output === undefined ? {} : { content: [{ type: "text", text: output }] }),
          ...(result === undefined ? {} : { result }),
          ...(exit === null ? {} : { exitCode: Number(exit[1]) }),
        }],
      };
    }
    case "llm_retry": {
      const retry = retryEvent(text(event.text) ?? "");
      return { task, events: retry === null ? [] : [retry] };
    }
    case "context_compaction_start": {
      const trigger = text(event.reason);
      return { task, events: [{ kind: "compaction_started", ...(trigger === undefined ? {} : { trigger }) }] };
    }
    case "context_compaction_done":
      return { task, events: [{ kind: "compaction_ended", outcome: "completed" }] };
    case "context_compaction_failed": {
      const reason = text(event.error) ?? text(event.reason);
      return { task, events: [{ kind: "compaction_ended", outcome: "failed", ...(reason === undefined ? {} : { reason }) }] };
    }
    case "steer_applied": {
      // The steer text entering the conversation; morph names no input id.
      const input = text(event.text);
      return { task, events: input === undefined ? [] : [{ kind: "user_message", input, evidence: "conversation" }] };
    }
    default:
      return { task, events: [] };
  }
}

function readTrace(state: MorphProjection, taskId: string, task: MorphTaskProjection, trace: unknown): { state: MorphProjection; task: MorphTaskProjection; events: RuntimeEventBody[] } {
  let current = task;
  let projection = state;
  const events: RuntimeEventBody[] = [];
  for (const entry of asRecordList(asRecord(trace)?.entries)) {
    const seq = asNumber(entry.seq);
    const event = asRecord(entry.event);
    if (seq === null || event === null || seq <= current.traceSeq) {
      continue;
    }
    const model = modelEvents(projection, event.model);
    projection = model.state;
    events.push(...model.events);
    const read = traceEvent(current, taskId, seq, event);
    current = { ...read.task, traceSeq: seq };
    events.push(...read.events);
  }
  return { state: projection, task: current, events };
}

/** The part of a snapshot not yet read: the tail when it extends what was read, the whole of it as a new message otherwise. */
function readText(task: MorphTaskProjection, taskId: string, snapshot: string): { task: MorphTaskProjection; events: RuntimeEventBody[] } {
  if (snapshot === task.text || snapshot === "") {
    return { task, events: [] };
  }
  if (snapshot.startsWith(task.text)) {
    return { task: { ...task, text: snapshot }, events: [{ kind: "text_delta", text: snapshot.slice(task.text.length), messageId: `${taskId}:${String(task.message)}` }] };
  }
  const message = task.text === "" ? task.message : task.message + 1;
  return { task: { ...task, text: snapshot, message }, events: [{ kind: "text_delta", text: snapshot, messageId: `${taskId}:${String(message)}` }] };
}

function readReasoning(task: MorphTaskProjection, snapshot: string): { task: MorphTaskProjection; events: RuntimeEventBody[] } {
  if (snapshot === "" || snapshot === task.reasoning) {
    return { task, events: [] };
  }
  const piece = snapshot.startsWith(task.reasoning) ? snapshot.slice(task.reasoning.length) : snapshot;
  return { task: { ...task, reasoning: snapshot }, events: [{ kind: "reasoning", content: { kind: "text", text: piece } }] };
}

function withTask(state: MorphProjection, taskId: string, task: MorphTaskProjection): MorphProjection {
  return { ...state, tasks: { ...state.tasks, [taskId]: task } };
}

/** What one `/stream/ws` snapshot adds. Never a turn end: the stream's `done` is a hint, the task query decides. */
export function foldMorphStream(state: MorphProjection, frame: unknown): MorphFold {
  const record = asRecord(frame);
  const taskId = text(record?.task_id);
  if (record === null || taskId === undefined) {
    return { state, events: [] };
  }
  const trace = readTrace(state, taskId, state.tasks[taskId] ?? initialTask, record.trace);
  const reasoning = readReasoning(trace.task, text(record.reasoning) ?? "");
  // A preview is Console's tool status line; a failed or canceled snapshot
  // carries the error as its text ("stopped by user", observed 2026-10-04).
  const errored = record.status === "failed" || record.status === "canceled" || text(record.error) !== undefined;
  const said = record.preview === true || errored ? { task: reasoning.task, events: [] } : readText(reasoning.task, taskId, text(record.text) ?? "");
  return {
    state: withTask(trace.state, taskId, said.task),
    events: [...trace.events, ...reasoning.events, ...said.events],
  };
}

function outcomeOf(info: JsonRecord): TurnOutcome {
  if (info.status === "done") {
    return { kind: "completed" };
  }
  if (info.status === "canceled") {
    return { kind: "aborted" };
  }
  const reason = text(info.error) ?? "morph task failed";
  return { kind: "failed", reason, failure: classifyFailure(reason) };
}

function finalOutput(result: JsonRecord | null): string | undefined {
  const output = asRecord(result?.final)?.output;
  if (output === undefined || output === null) {
    return undefined;
  }
  return typeof output === "string" ? text(output) : JSON.stringify(output);
}

/**
 * What a `GET /tasks/{id}` answer adds. A terminal one reads whatever trace,
 * reasoning and answer the stream did not deliver, then the turn end; any
 * other status adds nothing (its frame still enters the stream).
 */
export function foldMorphTask(state: MorphProjection, info: unknown): MorphFold {
  const record = asRecord(info);
  const taskId = text(record?.id);
  if (record === null || taskId === undefined || typeof record.status !== "string" || !TERMINAL_TASK_STATUSES.has(record.status)) {
    return { state, events: [] };
  }
  const result = asRecord(record.result);
  const model = modelEvents(state, record.model);
  const trace = readTrace(model.state, taskId, state.tasks[taskId] ?? initialTask, result?.trace);
  const reasoning = readReasoning(trace.task, text(result?.reasoning) ?? "");
  // Only a finished task's output is the agent's answer: a canceled or failed
  // one carries the error there ("stopped by user"), which the turn end reports.
  const answer = record.status === "done" ? finalOutput(result) : undefined;
  const said = answer === undefined ? { task: reasoning.task, events: [] } : readText(reasoning.task, taskId, answer);
  const tasks = { ...trace.state.tasks };
  delete tasks[taskId];
  return {
    state: { ...trace.state, tasks },
    events: [...model.events, ...trace.events, ...reasoning.events, ...said.events, { kind: "turn_ended", outcome: outcomeOf(record) }],
  };
}

/** The topic's context fullness from `GET /topic/{id}/metadata`, when Console has measured it. */
export function morphContextEvents(metadata: unknown): readonly RuntimeEventBody[] {
  const context = asRecord(asRecord(metadata)?.context);
  if (context?.available !== true) {
    return [];
  }
  const tokens = asNumber(context.used_input_tokens);
  const contextWindow = asNumber(context.context_window_tokens);
  const ratio = asNumber(context.usage_ratio);
  return [{
    kind: "usage",
    usage: { context: { tokens, contextWindow, percent: ratio === null ? null : ratio * 100 } },
  }];
}
