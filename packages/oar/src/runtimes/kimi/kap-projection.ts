import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import type { RecordAt } from "../../shared/session-kernel.js";
import { projectContextUsage, projectRetryUpdate, projectStepUsage } from "./kap-failures.js";
import { projectItemEvents, recordChildAgent, registerChildAgentsFromRefs } from "./kap-items.js";
import {
  asString,
  asStringArray,
  stringifyToolInput,
  type KapEndedTurnRef,
  type KapProjectedFrame,
  type KapProjectionOptions,
  type KapProjectionState,
  type KapTurnRef,
} from "./kap-projection-state.js";
import {
  projectInteractionEvent,
  projectTaskEvents,
  projectTurnEndedEvents,
  projectTurnStartedEvents,
} from "./kap-turns.js";

export { kapFailedTurn } from "./kap-failures.js";
export {
  createKapProjection,
  type KapEndedTurnRef,
  type KapPendingInteraction,
  type KapProjectedFrame,
  type KapProjectionOptions,
  type KapProjectionState,
  type KapTurnRef,
} from "./kap-projection-state.js";

function projectAgentMetaFrame(
  state: KapProjectionState,
  agentId: string,
  rawFrame: JsonRecord,
  events: RuntimeEventBody[],
): void {
  const model = asString(rawFrame.model);
  if (model !== undefined && model.length > 0 && state.lastModelByAgent.get(agentId) !== model) {
    state.lastModelByAgent.set(agentId, model);
    events.push({ kind: "model", model });
  }
  const thinking = asString(rawFrame.thinking);
  if (thinking !== undefined && thinking.length > 0 && state.lastEffortByAgent.get(agentId) !== thinking) {
    state.lastEffortByAgent.set(agentId, thinking);
    events.push({ kind: "effort", effort: thinking });
  }
}

function projectTaskListFrame(
  state: KapProjectionState,
  agentId: string,
  agentPath: readonly string[],
  rawFrame: JsonRecord,
  subscribeAgents: string[],
): void {
  for (const task of asRecordList(rawFrame.tasks)) {
    const childAgentId = asString(task.child_agent_id);
    const parentToolCallId = asString(task.parent_tool_call_id);
    recordChildAgent(state, agentPath, parentToolCallId ?? childAgentId ?? "task", childAgentId, subscribeAgents);
    if (agentId !== "main") { continue; }
    const taskId = asString(task.task_id);
    if (taskId !== undefined && asString(task.status) === "ended") {
      state.startedTaskIds.add(taskId);
      state.endedTaskIds.add(taskId);
    }
  }
}

interface TurnsSnapshotResult {
  readonly openedTurn?: KapTurnRef;
  readonly endedTurn?: KapEndedTurnRef;
  readonly rootUserPromptIds?: readonly string[];
}

function projectTurnsSnapshot(
  state: KapProjectionState,
  agentId: string,
  agentPath: readonly string[],
  rawFrame: JsonRecord,
  options: KapProjectionOptions,
  events: RuntimeEventBody[],
  subscribeAgents: string[],
): TurnsSnapshotResult {
  const turns = asRecordList(rawFrame.turns);
  const isFirstSnapshot = !state.seenInitialTurns.has(agentId);
  state.seenInitialTurns.add(agentId);
  if (agentId === "main" && isFirstSnapshot) {
    for (const turn of turns) {
      const turnId = asString(turn.turn_id);
      if (turnId === undefined) { continue; }
      if (asString(turn.status) === "ended" && !state.startedTurnIds.has(turnId)) {
        state.historicalTurnIds.add(turnId);
        if (asString(turn.kind) === "system") { state.systemTurnIds.add(turnId); }
      }
    }
  }
  let openedTurn: KapTurnRef | null = null;
  let endedTurn: KapEndedTurnRef | null = null;
  const rootPromptIds: string[] = [];
  for (const turn of turns) {
    const turnId = asString(turn.turn_id);
    if (turnId !== undefined && state.historicalTurnIds.has(turnId)) { continue; }
    const started = projectTurnStartedEvents(state, agentId, turn, events);
    if (started !== undefined) { openedTurn = started; endedTurn = null; }
    for (const item of asRecordList(turn.items)) {
      const evType = asString(item.status) === "running" ? "item.started" : "item.ended";
      projectItemEvents(state, evType, agentPath, turnId, item, options, events, subscribeAgents);
      if (agentId === "main" && asString(item.type) === "user_message") {
        rootPromptIds.push(...asStringArray(item.prompt_ids));
      }
    }
    if (asString(turn.status) === "ended") {
      const ended = projectTurnEndedEvents(state, agentId, turn, events);
      if (ended !== undefined) { endedTurn = ended; }
    }
  }
  return {
    ...(openedTurn === null ? {} : { openedTurn }),
    ...(endedTurn === null ? {} : { endedTurn }),
    ...(rootPromptIds.length > 0 ? { rootUserPromptIds: rootPromptIds } : {}),
  };
}

function projectItemDelta(
  state: KapProjectionState,
  frameTurnId: string | undefined,
  rawFrame: JsonRecord,
  events: RuntimeEventBody[],
): void {
  const itemId = asString(rawFrame.item_id);
  const field = asString(rawFrame.field);
  const delta = asString(rawFrame.delta);
  if (itemId === undefined || field === undefined || delta === undefined || delta.length === 0) { return; }
  if (frameTurnId !== undefined && state.historicalTurnIds.has(frameTurnId)) { return; }
  if (field === "text") {
    const prevLen = state.emittedTextLength.get(itemId) ?? 0;
    state.emittedTextLength.set(itemId, prevLen + delta.length);
    if (state.itemTypes.get(itemId) === "reasoning") {
      events.push({ kind: "reasoning", content: { kind: "text", text: delta }, messageId: itemId });
    } else {
      events.push({ kind: "text_delta", text: delta, messageId: itemId });
    }
    return;
  }
  if (field === "input_text") {
    events.push({ kind: "tool_call_input_delta", callId: itemId, delta });
  } else if (field === "output") {
    events.push({ kind: "tool_call_progress", callId: itemId, outputDelta: delta });
  }
}

export function projectKapFrame(
  state: KapProjectionState,
  rawFrame: JsonRecord,
  options: KapProjectionOptions,
): KapProjectedFrame {
  const type = asString(rawFrame.type) ?? "unknown";
  const agentId = asString(rawFrame.agent_id) ?? "main";
  const agentPath = agentId === "main" ? [] : (state.agentPaths.get(agentId) ?? [agentId]);
  const turnRecord = asRecord(rawFrame.turn);
  const frameTurnId = asString(rawFrame.turn_id) ?? (turnRecord === null ? undefined : asString(turnRecord.turn_id));
  const resolvedSpan = frameTurnId !== undefined && !state.systemTurnIds.has(frameTurnId)
    ? frameTurnId
    : state.activeTurnByAgent.get(agentId);
  const at: RecordAt = { agentPath, ...(resolvedSpan === undefined ? {} : { spanId: resolvedSpan }) };
  const events: RuntimeEventBody[] = [];
  const subscribeAgents: string[] = [];

  if (type === "agent") {
    projectAgentMetaFrame(state, agentId, rawFrame, events);
    return { at, body: { type, native: rawFrame, events } };
  }
  if (type === "context") {
    projectContextUsage(rawFrame, events);
    return { at, body: { type, native: rawFrame, events } };
  }
  if (type === "task") {
    projectTaskEvents(state, agentPath, rawFrame, events, subscribeAgents);
    return { at, body: { type, native: rawFrame, events }, ...(subscribeAgents.length > 0 ? { subscribeAgents } : {}) };
  }
  if (type === "task.list") {
    projectTaskListFrame(state, agentId, agentPath, rawFrame, subscribeAgents);
    return { at, body: { type, native: rawFrame, events: [] }, ...(subscribeAgents.length > 0 ? { subscribeAgents } : {}) };
  }
  if (type === "interaction") {
    const outcome = projectInteractionEvent(state, agentId, rawFrame, options, events);
    return { at, body: { type, native: rawFrame, events }, ...outcome };
  }
  if (type === "turns") {
    const snapshot = projectTurnsSnapshot(state, agentId, agentPath, rawFrame, options, events, subscribeAgents);
    const spanId = snapshot.openedTurn?.turnId ?? snapshot.endedTurn?.turnId ?? resolvedSpan;
    return {
      at: { agentPath, ...(spanId === undefined ? {} : { spanId }) },
      body: { type, native: rawFrame, events },
      ...(subscribeAgents.length > 0 ? { subscribeAgents } : {}),
      ...snapshot,
    };
  }
  if (type === "turn.started" && turnRecord !== null) {
    const openedTurn = projectTurnStartedEvents(state, agentId, turnRecord, events);
    const spanId = openedTurn === undefined ? resolvedSpan : openedTurn.turnId;
    return {
      at: { agentPath, ...(spanId === undefined ? {} : { spanId }) },
      body: { type, native: rawFrame, events },
      ...(openedTurn === undefined ? {} : { openedTurn }),
    };
  }
  if (type === "turn.updated") {
    const turnId = asString(rawFrame.turn_id);
    if (turnId !== undefined && !state.historicalTurnIds.has(turnId) && !state.systemTurnIds.has(turnId)) {
      const step = asRecord(rawFrame.step);
      if (step !== null) { projectStepUsage(state, agentId, turnId, step, events); }
      const retry = asRecord(rawFrame.retry);
      if (retry !== null) { projectRetryUpdate(retry, events); }
    }
    return { at, body: { type, native: rawFrame, events } };
  }
  if (type === "turn.ended" && turnRecord !== null) {
    const endedTurn = projectTurnEndedEvents(state, agentId, turnRecord, events);
    return { at, body: { type, native: rawFrame, events }, ...(endedTurn === undefined ? {} : { endedTurn }) };
  }
  if (type === "item.started" || type === "item.ended") {
    const item = asRecord(rawFrame.item);
    let rootUserPromptIds: readonly string[] | null = null;
    if (item !== null) {
      projectItemEvents(state, type, agentPath, frameTurnId, item, options, events, subscribeAgents);
      if (
        agentId === "main" &&
        asString(item.type) === "user_message" &&
        (frameTurnId === undefined || !state.historicalTurnIds.has(frameTurnId))
      ) {
        const ids = asStringArray(item.prompt_ids);
        if (ids.length > 0) { rootUserPromptIds = ids; }
      }
    }
    return {
      at,
      body: { type, native: rawFrame, events },
      ...(subscribeAgents.length > 0 ? { subscribeAgents } : {}),
      ...(rootUserPromptIds === null ? {} : { rootUserPromptIds }),
    };
  }
  if (type === "item.updated") {
    const itemId = asString(rawFrame.item_id);
    const set = asRecord(rawFrame.set);
    if (itemId !== undefined && set !== null && (frameTurnId === undefined || !state.historicalTurnIds.has(frameTurnId))) {
      registerChildAgentsFromRefs(state, agentPath, itemId, set.agent_refs, subscribeAgents);
      const inputStr = stringifyToolInput(set.input);
      if (inputStr !== undefined) { events.push({ kind: "tool_call_input", callId: itemId, input: inputStr }); }
      const output = asString(set.output);
      if (output !== undefined) { events.push({ kind: "tool_call_progress", callId: itemId, output }); }
    }
    return { at, body: { type, native: rawFrame, events }, ...(subscribeAgents.length > 0 ? { subscribeAgents } : {}) };
  }
  if (type === "item.delta") {
    projectItemDelta(state, frameTurnId, rawFrame, events);
  }
  return { at, body: { type, native: rawFrame, events } };
}
