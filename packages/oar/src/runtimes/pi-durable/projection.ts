import type { AgentState, ConversationView, EntryRecord, LiveState, NestedToolSlot, SubmissionId, SubmissionRecord, ToolSlot, UsageState, WatchCall } from "@earendil-works/pi-durable";
import type { FrameBody, RuntimeEventBody, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { toolContent } from "../../shared/tool-output.js";
import { addTokens, subtractTokens } from "../../shared/token-totals.js";
import { emptyMessage, wholeMessage, type MessageProjection } from "./messages.js";

export interface DurableProjection {
  readonly view: ConversationView;
  readonly message: MessageProjection;
  readonly baseline: TokenTotals;
  readonly runInputs: readonly SubmissionId[];
}

// These built-in documents are materialized by the native Harness using its
// own versioned definitions before it publishes a ConversationView.
export function liveOf(view: ConversationView): LiveState { return view.docs["pi.live"] ?? {}; }
function agentOf(view: ConversationView): AgentState { return view.docs["pi.agent"] ?? {}; }
function usageOf(view: ConversationView): UsageState {
  const usage = view.docs["pi.usage"];
  return hasUsageLedgers(usage) ? usage : { models: {}, tools: {} };
}
function hasUsageLedgers(value: ConversationView["docs"][string] | undefined): value is UsageState {
  return value !== undefined && typeof value.models === "object" && value.models !== null && typeof value.tools === "object" && value.tools !== null;
}

function usageTotal(usage: UsageState): TokenTotals {
  return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce<TokenTotals>((total, item) => addTokens(total, {
    input: item.input + item.cacheRead + item.cacheWrite, output: item.output, cacheRead: item.cacheRead, cacheWrite: item.cacheWrite,
    ...(item.reasoning === undefined ? {} : { reasoning: item.reasoning }),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

export function initialDurableProjection(view: ConversationView): DurableProjection {
  return { view, message: emptyMessage, baseline: usageTotal(usageOf(view)), runInputs: liveOf(view).run?.inputs ?? [] };
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

function settingsEvents(previous: DurableProjection, view: ConversationView, initial: boolean): RuntimeEventBody[] {
  const agent = agentOf(view);
  const before = agentOf(previous.view);
  return [
    ...(agent.model !== undefined && (initial || JSON.stringify(agent.model) !== JSON.stringify(before.model)) ? [{ kind: "model" as const, model: `${agent.model.provider}/${agent.model.modelId}` }] : []),
    ...(agent.thinkingLevel !== undefined && (initial || agent.thinkingLevel !== before.thinkingLevel) ? [{ kind: "effort" as const, effort: agent.thinkingLevel }] : []),
    { kind: "usage", usage: { tokens: subtractTokens(usageTotal(usageOf(view)), previous.baseline) } },
  ];
}

function slots(view: ConversationView): readonly (ToolSlot | NestedToolSlot)[] {
  const live = liveOf(view);
  return [...live.tools ?? [], ...live.nestedTools ?? []];
}

function toolArguments(slot: ToolSlot | NestedToolSlot, view: ConversationView): unknown {
  if ("arguments" in slot) { return slot.arguments; }
  const block = view.entries.flatMap(entry => entry.model ?? []).flatMap(message => message.role === "assistant" ? message.content : [])
    .find(item => item.type === "toolCall" && item.id === slot.callId);
  return block?.type === "toolCall" ? block.arguments : undefined;
}

function toolEvents(previous: ConversationView, view: ConversationView, entries: readonly EntryRecord[], initial: boolean): RuntimeEventBody[] {
  const before = new Map((initial ? [] : slots(previous)).map(slot => [slot.callId, slot]));
  const events: RuntimeEventBody[] = [];
  for (const slot of slots(view)) {
    const candidate = before.get(slot.callId);
    const prior = candidate?.taskId === slot.taskId ? candidate : undefined;
    if (slot.status === "pending" || (initial && slot.status === "done")) { continue; }
    if (prior === undefined || prior.status === "pending") {
      const args = toolArguments(slot, view);
      events.push({ kind: "tool_call_started", callId: slot.callId, tool: slot.name,
        ...(args === undefined ? {} : { arguments: args }) });
    }
    if (slot.status === "running" && slot.output !== undefined && slot.output !== prior?.output) {
      events.push({ kind: "tool_call_progress", callId: slot.callId, output: slot.output });
    }
    if (slot.status === "done" && prior?.status !== "done") {
      const entry = "entry" in slot ? [...entries, ...view.entries].find(item => item.id === slot.entry) : undefined;
      const result = entry?.model?.find(message => message.role === "toolResult");
      const summary = "summary" in slot ? slot.summary : undefined;
      const outcome = result ?? summary;
      const content = result === undefined ? undefined : toolContent(result.content);
      events.push({ kind: "tool_call_ended", callId: slot.callId,
        ...(content === undefined ? {} : { content }),
        ...(outcome === undefined ? {} : { result: (outcome.isError ? "failed" : "ok") }) });
    }
  }
  return events;
}

function entryEvents(previous: DurableProjection, entries: readonly EntryRecord[], inputs: readonly SubmissionRecord[]): { readonly message: MessageProjection; readonly events: RuntimeEventBody[] } {
  let message = previous.message;
  const events: RuntimeEventBody[] = [];
  for (const entry of entries) {
    for (const value of entry.model ?? []) {
      if (value.role === "assistant") {
        const current = entry.byTaskId === liveOf(previous.view).run?.taskId;
        events.push(...wholeMessage(current ? message : emptyMessage, value).events);
        if (current) { message = emptyMessage; }
      } else if (value.role === "user") {
        const input = typeof value.content === "string" ? value.content : value.content.filter(block => block.type === "text").map(block => block.text).join("");
        const submission = inputs.find(record => record.entry === entry.id);
        events.push({ kind: "user_message", input, nativeMessageId: String(entry.id), evidence: "conversation",
          ...(submission?.requestId === undefined ? {} : { inputId: submission.requestId }) });
      }
    }
  }
  return { message, events };
}

/** Entry appends remain in the native ops even when the view immediately trims its window. */
export function appendedEntries(previous: ConversationView, call: Extract<WatchCall<ConversationView>, { kind: "value" }>): readonly EntryRecord[] {
  const appended = nativeEntryAppends(call);
  if (appended.length > 0) { return appended; }
  const last = previous.entries.at(-1)?.id ?? previous.before ?? 0;
  return call.value.entries.filter(entry => entry.id > last);
}

function nativeEntryAppends(call: Extract<WatchCall<ConversationView>, { kind: "value" }>): readonly EntryRecord[] {
  // The native conversation mount inserts EntryRecords at this exact path,
  // before a separate splice trims the window. Keep those original entries.
  return call.ops.flatMap(op => op[0] === "p" && op[1].length === 1 && op[1][0] === "entries" ? op[4].flatMap<EntryRecord>(value => isEntry(value) ? [value] : []) : []);
}

function isEntry(value: unknown): value is EntryRecord {
  return typeof value === "object" && value !== null && "id" in value && Number.isSafeInteger(value.id)
    && "conversationId" in value && Number.isSafeInteger(value.conversationId) && "kind" in value && typeof value.kind === "string";
}

export function runEnded(previous: DurableProjection, call: Extract<WatchCall<ConversationView>, { kind: "value" }>): boolean {
  const before = liveOf(previous.view).run;
  // A final boundary can delete the old run and start the queued run in one
  // publication. A generation handover only changes run.taskId, not the run.
  const removed = call.ops.some(op => op[0] === "d" && op[1].length === 3 && op[1][0] === "docs" && op[1][1] === "pi.live" && op[1][2] === "run");
  return before !== undefined && (liveOf(call.value).run === undefined || removed);
}

/** One native state notification is one frame. No old AgentEvent is synthesized. */
export function foldDurableView(previous: DurableProjection, native: Extract<WatchCall<ConversationView>, { kind: "value" }>, inputs: readonly SubmissionRecord[] = [], initial = false, outcome?: TurnOutcome): { readonly state: DurableProjection; readonly frame: FrameBody } {
  const view = native.value;
  const live = liveOf(view);
  const before = liveOf(previous.view);
  const entries = initial ? [] : appendedEntries(previous.view, native);
  const entry = entryEvents(previous, entries, inputs);
  const message = live.generation?.message;
  const sameGeneration = before.run?.taskId === live.run?.taskId && before.generation?.attempt === live.generation?.attempt;
  const nextMessage = message === undefined ? { state: emptyMessage, events: [] } : wholeMessage(sameGeneration ? entry.message : emptyMessage, message);
  const newRun = live.run !== undefined && (initial || before.run === undefined || runEnded(previous, native));
  const oldCompactions = initial ? [] : before.compactions ?? [];
  const retry = live.generation?.retry;
  const events: RuntimeEventBody[] = [
    ...settingsEvents(previous, view, initial),
    ...entry.events,
    ...(outcome === undefined ? [] : [{ kind: "turn_ended" as const, outcome }]),
    ...(newRun ? [{ kind: "turn_active" as const }] : []),
    ...nextMessage.events, ...toolEvents(previous.view, view, entries, initial),
    ...(live.compactions ?? []).flatMap(item => item.blocking && !oldCompactions.some(prior => prior.taskId === item.taskId) ? [{ kind: "compaction_started" as const, trigger: item.trigger }] : []),
    ...(retry !== undefined && (initial || retry.at !== before.generation?.retry?.at) ? [{ kind: "retry" as const, attempt: live.generation?.attempt ?? 0, reason: retry.error }] : []),
  ];
  const runInputs = newRun ? live.run?.inputs ?? [] : (live.run === undefined ? [] : [...new Set([...previous.runInputs, ...live.run.inputs])]);
  return { state: { view, message: nextMessage.state, baseline: previous.baseline, runInputs }, frame: { type: initial ? "snapshot" : "pi-durable/view", native, events } };
}
