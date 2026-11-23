import type { ReasoningContent, RuntimeEventBody } from "../../contracts/session.js";
import { asNumber, asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { toolContent } from "../../shared/tool-output.js";
import { asString, asStringArray, stringifyToolInput, type KapProjectionOptions, type KapProjectionState } from "./kap-projection-state.js";

export function recordChildAgent(
  state: KapProjectionState,
  parentPath: readonly string[],
  toolCallId: string,
  childAgentId: string | undefined,
  subscribeAgents: string[],
): void {
  if (childAgentId === undefined || childAgentId === "main") { return; }
  if (!state.agentPaths.has(childAgentId)) {
    state.agentPaths.set(childAgentId, [...parentPath, toolCallId]);
  }
  if (!state.subscribedAgents.has(childAgentId)) {
    state.subscribedAgents.add(childAgentId);
    subscribeAgents.push(childAgentId);
  }
}

/** Task snapshots and live notices describe the same child as the spawning tool item's agent_refs. */
export function recordTaskAgent(state: KapProjectionState, parentPath: readonly string[], task: JsonRecord, taskId: string, subscribeAgents: string[]): string | undefined {
  const childId = asString(task.child_agent_id);
  const reported = asString(task.parent_tool_call_id);
  const previous = childId === undefined ? undefined : state.agentPaths.get(childId)?.at(-1);
  const toolCallId = reported ?? (previous === taskId ? undefined : previous);
  // A live task can identify a spawning call that its initial snapshot omitted.
  if (childId !== undefined && previous !== undefined && reported !== undefined && previous !== reported) {
    state.agentPaths.delete(childId);
    state.lastModelByAgent.delete(childId);
    state.lastEffortByAgent.delete(childId);
  }
  recordChildAgent(state, parentPath, toolCallId ?? taskId, childId, subscribeAgents);
  return toolCallId;
}

export function registerChildAgentsFromRefs(
  state: KapProjectionState,
  parentPath: readonly string[],
  toolCallId: string,
  refsRaw: unknown,
  subscribeAgents: string[],
): void {
  for (const ref of asRecordList(refsRaw)) {
    recordChildAgent(state, parentPath, toolCallId, asString(ref.agent_id), subscribeAgents);
  }
}

export function recordTurnPromptIds(state: KapProjectionState, turnId: string | undefined, promptIds: readonly string[]): void {
  if (turnId === undefined || promptIds.length === 0) { return; }
  let existing = state.turnPromptIds.get(turnId);
  if (existing === undefined) {
    existing = [];
    state.turnPromptIds.set(turnId, existing);
  }
  for (const promptId of promptIds) {
    if (!existing.includes(promptId)) { existing.push(promptId); }
  }
}

function mapToolResult(item: JsonRecord): "ok" | "failed" | undefined {
  const outcome = asString(item.outcome);
  if (asString(item.error) !== undefined || outcome === "failed") { return "failed"; }
  if (outcome === "completed") { return "ok"; }
  return undefined;
}

function mapToolExitCode(fields: JsonRecord | null): number | null | undefined {
  if (fields === null) { return undefined; }
  if (fields.exit_code === null) { return null; }
  const rawExitCode = asNumber(fields.exit_code);
  return rawExitCode ?? undefined;
}

function mapCompactionOutcome(outcome: string | undefined): "completed" | "aborted" | "failed" {
  if (outcome === "interrupted") { return "aborted"; }
  if (outcome === "failed") { return "failed"; }
  return "completed";
}

function projectUserMessageItem(
  state: KapProjectionState,
  eventType: "item.started" | "item.ended",
  turnId: string | undefined,
  itemId: string,
  item: JsonRecord,
  events: RuntimeEventBody[],
): void {
  if (state.emittedUserMessageIds.has(itemId)) { return; }
  const text = asString(item.text) ?? "";
  if (eventType === "item.started" && text.length === 0) { return; }
  state.emittedUserMessageIds.add(itemId);
  const promptIds = asStringArray(item.prompt_ids);
  recordTurnPromptIds(state, turnId, promptIds);
  events.push({
    kind: "user_message",
    input: text,
    ...(promptIds[0] === undefined ? {} : { inputId: promptIds[0] }),
    nativeMessageId: itemId,
    ...(turnId === undefined ? {} : { turnId }),
    evidence: "turn_item",
  });
}

function projectToolCallItem(
  state: KapProjectionState,
  eventType: "item.started" | "item.ended",
  parentPath: readonly string[],
  itemId: string,
  item: JsonRecord,
  events: RuntimeEventBody[],
  subscribeAgents: string[],
): void {
  const tool = asString(item.name) ?? "unknown";
  registerChildAgentsFromRefs(state, parentPath, itemId, item.agent_refs, subscribeAgents);
  const completeInput = stringifyToolInput(item.input);
  const partialInputText = completeInput === undefined && typeof item.input_text === "string" && item.input_text.length > 0
    ? item.input_text
    : undefined;
  const emitStart = (): void => {
    if (state.startedToolCalls.has(itemId)) { return; }
    state.startedToolCalls.add(itemId);
    if (completeInput !== undefined) {
      state.emittedCompleteToolInputs.set(itemId, completeInput);
    }
    events.push({ kind: "tool_call_started", callId: itemId, tool, ...(completeInput === undefined ? {} : { input: completeInput }) });
    if (partialInputText !== undefined) {
      events.push({ kind: "tool_call_input_delta", callId: itemId, delta: partialInputText });
    }
  };
  if (eventType === "item.started") {
    emitStart();
    return;
  }
  if (state.endedToolCalls.has(itemId)) { return; }
  state.endedToolCalls.add(itemId);
  const wasStarted = state.startedToolCalls.has(itemId);
  emitStart();
  if (wasStarted && completeInput !== undefined && state.emittedCompleteToolInputs.get(itemId) !== completeInput) {
    state.emittedCompleteToolInputs.set(itemId, completeInput);
    events.push({ kind: "tool_call_input", callId: itemId, input: completeInput });
  }
  const content = toolContent(item.output ?? item.error);
  const result = mapToolResult(item);
  const exitCode = mapToolExitCode(asRecord(item.fields));
  events.push({
    kind: "tool_call_ended",
    callId: itemId,
    ...(content === undefined ? {} : { content }),
    ...(result === undefined ? {} : { result }),
    ...(exitCode === undefined ? {} : { exitCode }),
  });
}

function projectCompactionItem(
  state: KapProjectionState,
  eventType: "item.started" | "item.ended",
  itemId: string,
  item: JsonRecord,
  options: KapProjectionOptions,
  events: RuntimeEventBody[],
): void {
  const trigger = asString(item.trigger) ?? (options.manualCompactionActive ? "manual" : "auto");
  const emitStart = (): void => {
    if (state.startedCompactions.has(itemId)) { return; }
    state.startedCompactions.add(itemId);
    events.push({ kind: "compaction_started", compactionId: itemId, trigger });
  };
  if (eventType === "item.started") {
    emitStart();
    return;
  }
  if (state.endedCompactions.has(itemId)) { return; }
  state.endedCompactions.add(itemId);
  emitStart();
  events.push({
    kind: "compaction_ended",
    compactionId: itemId,
    outcome: mapCompactionOutcome(asString(item.outcome)),
    trigger,
  });
}

export function projectItemEvents(
  state: KapProjectionState,
  eventType: "item.started" | "item.ended",
  parentPath: readonly string[],
  turnId: string | undefined,
  item: JsonRecord,
  options: KapProjectionOptions,
  events: RuntimeEventBody[],
  subscribeAgents: string[],
): void {
  const itemId = asString(item.item_id);
  const itemType = asString(item.type);
  if (itemId === undefined || itemType === undefined) { return; }
  // Compaction lives inside a system turn, so allow `system` items even inside systemTurnIds.
  if (turnId !== undefined && (state.historicalTurnIds.has(turnId) || state.systemTurnIds.has(turnId)) && itemType !== "system") {
    return;
  }
  state.itemTypes.set(itemId, itemType);
  if (itemType === "user_message") {
    projectUserMessageItem(state, eventType, turnId, itemId, item, events);
    return;
  }
  if (itemType === "assistant_message") {
    const text = asString(item.text) ?? "";
    const prevLen = state.emittedTextLength.get(itemId) ?? 0;
    if (text.length > prevLen) {
      state.emittedTextLength.set(itemId, text.length);
      events.push({ kind: "text_delta", text: text.slice(prevLen), messageId: itemId });
    }
    return;
  }
  if (itemType === "reasoning") {
    const text = asString(item.text) ?? "";
    const prevLen = state.emittedTextLength.get(itemId) ?? 0;
    if (text.length > prevLen) {
      state.emittedTextLength.set(itemId, text.length);
      const content: ReasoningContent = { kind: "text", text: text.slice(prevLen) };
      events.push({ kind: "reasoning", content, messageId: itemId });
    } else if (eventType === "item.ended" && text.length === 0 && prevLen === 0) {
      events.push({ kind: "reasoning", content: { kind: "empty" }, messageId: itemId });
    }
    return;
  }
  if (itemType === "tool_call") {
    projectToolCallItem(state, eventType, parentPath, itemId, item, events, subscribeAgents);
    return;
  }
  if (itemType === "system" && asString(item.kind) === "compaction") {
    projectCompactionItem(state, eventType, itemId, item, options, events);
  }
}
