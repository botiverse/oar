import type { AgentEvent, AgentState, EntryRecord, SnapshotEvent, SubmissionId, SubmissionRecord, UsageState } from "@earendil-works/pi-durable";
import type { FrameBody, RuntimeEventBody, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { toolContent } from "../../shared/tool-output.js";
import { foldPiEvent, initialPiProjection } from "../pi/projection.js";
import { emptyMessage, messageChanges, wholeMessage, type MessageProjection } from "./messages.js";

export interface DurableProjection {
  readonly message: MessageProjection;
  readonly baseline: TokenTotals;
  readonly submissions: ReadonlyMap<number, SubmissionRecord>;
  readonly run: readonly SubmissionId[];
  readonly tools: ReadonlyMap<string, string>;
}

function usageTotal(usage: UsageState): TokenTotals {
  return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce<TokenTotals>((total, item) => ({
    input: total.input + item.input + item.cacheRead + item.cacheWrite,
    output: total.output + item.output,
    cacheRead: (total.cacheRead ?? 0) + item.cacheRead,
    cacheWrite: (total.cacheWrite ?? 0) + item.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

export function initialDurableProjection(snapshot: SnapshotEvent): DurableProjection {
  return { message: emptyMessage, baseline: usageTotal(snapshot.usage), submissions: new Map(), run: [], tools: new Map() };
}

function agentEvents(agent: AgentState): RuntimeEventBody[] {
  return [
    ...(agent.model === undefined ? [] : [{ kind: "model" as const, model: `${agent.model.provider}/${agent.model.modelId}` }]),
    ...(agent.thinkingLevel === undefined ? [] : [{ kind: "effort" as const, effort: agent.thinkingLevel }]),
  ];
}

function usageEvent(state: DurableProjection, usage: UsageState): RuntimeEventBody {
  const total = usageTotal(usage);
  const base = state.baseline;
  return { kind: "usage", usage: { tokens: { input: total.input - base.input, output: total.output - base.output,
    cacheRead: (total.cacheRead ?? 0) - (base.cacheRead ?? 0), cacheWrite: (total.cacheWrite ?? 0) - (base.cacheWrite ?? 0) } } };
}

/** The native run's terminal submission receipts, never the adapter's abort intent. */
export function submissionOutcome(records: readonly (SubmissionRecord | undefined)[]): TurnOutcome | undefined {
  const unanswered = records.find((record) => record?.status === "unanswered");
  if (unanswered?.status === "unanswered") {
    if (unanswered.reason === "aborted") { return { kind: "aborted" }; }
    const reason = typeof unanswered.detail === "string" ? unanswered.detail : unanswered.reason;
    return { kind: "failed", reason, failure: classifyFailure(reason) };
  }
  return records.length > 0 && records.every((record) => record?.status === "done") ? { kind: "completed" } : undefined;
}

function entryEvents(state: DurableProjection, entry: EntryRecord): { readonly state: DurableProjection; readonly events: readonly RuntimeEventBody[] } {
  let messageState = state.message;
  const events: RuntimeEventBody[] = [];
  for (const message of entry.model ?? []) {
    if (message.role === "assistant") {
      const next = wholeMessage(messageState, message);
      events.push(...next.events);
      messageState = emptyMessage;
    } else if (message.role === "user") {
      const input = typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const submission = [...state.submissions.values()].find((record) => record.entry === entry.id);
      events.push({ kind: "user_message", input, nativeMessageId: String(entry.id), evidence: "conversation", ...(submission?.requestId === undefined ? {} : { inputId: submission.requestId }) });
    }
  }
  return { state: { ...state, message: messageState }, events };
}

function snapshotEvents(state: DurableProjection, event: SnapshotEvent): { readonly state: DurableProjection; readonly events: readonly RuntimeEventBody[] } {
  const partial = event.generation?.message;
  const next = partial === undefined ? { state: emptyMessage, events: [] } : wholeMessage(state.message, partial);
  return { state: { ...state, message: next.state, run: event.run?.inputs ?? [], tools: new Map(event.tools.filter((tool) => tool.status === "running").map((tool) => [tool.callId, tool.output ?? ""])) }, events: [
    ...agentEvents(event.agent),
    ...(event.run === undefined ? [] : [{ kind: "turn_active" as const }]),
    ...next.events,
    ...event.tools.filter((tool) => tool.status === "running" && !state.tools.has(tool.callId)).map((tool) => ({ kind: "tool_call_started" as const, callId: tool.callId, tool: tool.name })),
    ...event.tools.flatMap((tool) => tool.status === "running" && tool.output !== undefined ? [{ kind: "tool_call_progress" as const, callId: tool.callId, output: tool.output }] : []),
    usageEvent(state, event.usage),
  ] };
}

function step(state: DurableProjection, event: AgentEvent): { readonly state: DurableProjection; readonly events: readonly RuntimeEventBody[] } {
  switch (event.type) {
    case "snapshot": return snapshotEvents(state, event);
    case "run_start": return { state: { ...state, run: event.inputs }, events: [{ kind: "turn_active" }] };
    case "run_end": {
      const outcome = submissionOutcome(event.inputs.map((id) => state.submissions.get(id)));
      return { state: { ...state, run: [] }, events: outcome === undefined ? [] : [{ kind: "turn_ended", outcome }] };
    }
    case "message_start": {
      if (event.message.role !== "assistant") { return { state, events: [] }; }
      const next = wholeMessage(emptyMessage, event.message);
      return { state: { ...state, message: next.state }, events: next.events };
    }
    case "message_update": {
      const next = messageChanges(state.message, event.changes);
      return { state: { ...state, message: next.state }, events: next.events };
    }
    case "message_end": return entryEvents(state, event.entry);
    case "tool_execution_start":
      // This native event has precisely the coding SDK's shape. Reuse its pure reading,
      // while the frame below always retains the original durable batch.
      return { state: { ...state, tools: new Map(state.tools).set(event.toolCallId, "") }, events: foldPiEvent(initialPiProjection, event).commands.flatMap((command) => command.body.events) };
    case "tool_execution_update": {
      const before = state.tools.get(event.toolCallId) ?? "";
      const output = event.output === undefined ? before : ("set" in event.output ? event.output.set : before.slice(event.output.trimStart ?? 0) + (event.output.append ?? ""));
      return { state: { ...state, tools: new Map(state.tools).set(event.toolCallId, output) }, events: [{ kind: "tool_call_progress", callId: event.toolCallId, output }] };
    }
    case "tool_execution_end": {
      const result = event.entry?.model?.find((message) => message.role === "toolResult");
      const tools = new Map(state.tools);
      tools.delete(event.toolCallId);
      const content = result === undefined ? undefined : toolContent(result.content);
      return { state: { ...state, tools }, events: [{ kind: "tool_call_ended", callId: event.toolCallId,
        ...(content === undefined ? {} : { content }), ...(result === undefined ? {} : { result: result.isError ? "failed" : "ok" }) }] };
    }
    case "agent_changed": return { state, events: agentEvents(event.agent) };
    case "usage_changed": return { state, events: [usageEvent(state, event.usage)] };
    case "auto_retry_start": return { state, events: [{ kind: "retry", attempt: event.attempt, reason: event.errorMessage }] };
    case "submission": return { state, events: [] };
    case "compaction_start": return { state, events: event.blocking ? [{ kind: "compaction_started", trigger: event.reason }] : [] };
    // compaction_end reports only that its task disappeared, not its outcome.
    case "compaction_end":
    case "turn_start":
    case "turn_end":
    case "inbox_update":
    case "auto_retry_end":
    case "deferred_poll":
    case "entry_appended":
    case "task_failed": return { state, events: [] };
  }
  return { state, events: [] };
}

/** One complete native commit batch becomes one frame, including empty or unknown-only batches. */
export function foldDurableBatch(previous: DurableProjection, native: readonly AgentEvent[]): { readonly state: DurableProjection; readonly frame: FrameBody } {
  const submissions = new Map(previous.submissions);
  for (const event of native) { if (event.type === "submission") { submissions.set(event.record.id, event.record); } }
  let state = { ...previous, submissions };
  const events: RuntimeEventBody[] = [];
  for (const event of native) {
    const next = step(state, event);
    state = { ...next.state, submissions };
    events.push(...next.events);
  }
  return { state, frame: { type: "pi-durable/events", native, events } };
}
