import type {
  RuntimeEventBody,
  TaskEventBody,
  TaskStatus,
  TaskType,
  TurnOutcome,
  UsageReport,
} from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import {
  addAgentUsageDelta,
  diffNonNegativeTokens,
  kapFailedTurn,
  parseKapUsage,
  sumStepUsages,
} from "./kap-failures.js";
import { recordTaskAgent } from "./kap-items.js";
import {
  asBoolean,
  asString,
  type KapEndedTurnRef,
  type KapPendingInteraction,
  type KapProjectionOptions,
  type KapProjectionState,
  type KapTurnRef,
} from "./kap-projection-state.js";

function mapTaskType(kind: string | undefined): TaskType {
  if (kind === "subagent") { return "agent"; }
  if (kind === "shell") { return "shell"; }
  return "other";
}

function mapTaskEndStatus(outcome: string | undefined): "completed" | "failed" | "stopped" {
  if (outcome === "completed") { return "completed"; }
  if (outcome === "killed") { return "stopped"; }
  return "failed";
}

function mapTurnOutcome(turn: JsonRecord): TurnOutcome {
  const rawOutcome = asString(turn.outcome);
  if (rawOutcome === "completed") { return { kind: "completed" }; }
  const endReason = asString(turn.end_reason);
  if (rawOutcome === "interrupted" || endReason === "user_cancelled" || endReason === "aborted") {
    return { kind: "aborted" };
  }
  return kapFailedTurn(endReason, turn.error);
}

export function projectTurnStartedEvents(
  state: KapProjectionState,
  agentId: string,
  turn: JsonRecord,
  events: RuntimeEventBody[],
): KapTurnRef | undefined {
  const turnId = asString(turn.turn_id);
  if (turnId === undefined) { return undefined; }
  if (asString(turn.kind) === "system") {
    state.systemTurnIds.add(turnId);
    return undefined;
  }
  if (state.historicalTurnIds.has(turnId) || state.startedTurnIds.has(turnId)) {
    return undefined;
  }
  state.startedTurnIds.add(turnId);
  state.activeTurnByAgent.set(agentId, turnId);
  events.push({ kind: "turn_active" });
  const steeredFromTurnId = asString(turn.steered_from_turn_id);
  const steeredFromPromptId = asString(turn.steered_from_prompt_id);
  return {
    turnId,
    agentId,
    ...(steeredFromTurnId === undefined ? {} : { steeredFromTurnId }),
    ...(steeredFromPromptId === undefined ? {} : { steeredFromPromptId }),
  };
}

export function projectTurnEndedEvents(
  state: KapProjectionState,
  agentId: string,
  turn: JsonRecord,
  events: RuntimeEventBody[],
): KapEndedTurnRef | undefined {
  const turnId = asString(turn.turn_id);
  if (turnId === undefined) { return undefined; }
  if (asString(turn.kind) === "system" || state.systemTurnIds.has(turnId)) {
    state.systemTurnIds.add(turnId);
    return undefined;
  }
  if (state.historicalTurnIds.has(turnId) || state.endedTurnIds.has(turnId)) {
    return undefined;
  }
  state.endedTurnIds.add(turnId);
  if (state.activeTurnByAgent.get(agentId) === turnId) {
    state.activeTurnByAgent.delete(agentId);
  }
  const turnUsage = parseKapUsage(turn.usage);
  if (turnUsage !== undefined) {
    const summed = sumStepUsages(state.stepUsageByTurn.get(turnId));
    const cumulative = addAgentUsageDelta(state, agentId, diffNonNegativeTokens(turnUsage, summed));
    if (cumulative !== undefined) {
      const report: UsageReport = { tokens: cumulative };
      events.push({ kind: "usage", usage: report });
    }
  }
  state.stepUsageByTurn.delete(turnId);
  const promptIds = state.turnPromptIds.get(turnId);
  state.turnPromptIds.delete(turnId);
  const outcome = mapTurnOutcome(turn);
  events.push({
    kind: "turn_ended",
    outcome,
    ...(promptIds !== undefined && promptIds.length === 1 && promptIds[0] !== undefined ? { inputId: promptIds[0] } : {}),
    ...(promptIds !== undefined && promptIds.length > 1 ? { inputIds: [...promptIds] } : {}),
  });
  return { turnId, agentId, outcome: outcome.kind };
}

export function projectTaskEvents(
  state: KapProjectionState,
  agentPath: readonly string[],
  rawFrame: JsonRecord,
  events: RuntimeEventBody[],
  subscribeAgents: string[],
): void {
  const taskId = asString(rawFrame.task_id);
  if (taskId === undefined) { return; }
  const parentToolCallId = recordTaskAgent(state, agentPath, rawFrame, taskId, subscribeAgents);
  const status = asString(rawFrame.status);
  const nativeType = asString(rawFrame.kind);
  const description = asString(rawFrame.description);
  const detached = asBoolean(rawFrame.detached);
  if (!state.startedTaskIds.has(taskId)) {
    state.startedTaskIds.add(taskId);
    const started: TaskEventBody = {
      kind: "task_started",
      taskId,
      taskType: mapTaskType(nativeType),
      ...(nativeType === undefined ? {} : { nativeType }),
      ...(description === undefined ? {} : { description }),
      ...(parentToolCallId === undefined ? {} : { toolCallId: parentToolCallId }),
      ...(detached === undefined ? {} : { background: detached }),
    };
    events.push(started);
  } else if (status === "running") {
    const updated: TaskEventBody = {
      kind: "task_updated",
      taskId,
      status: "running" satisfies TaskStatus,
      ...(detached === undefined ? {} : { background: detached }),
      ...(description === undefined ? {} : { description }),
    };
    events.push(updated);
  }
  if (status === "ended" && !state.endedTaskIds.has(taskId)) {
    state.endedTaskIds.add(taskId);
    const summary = asString(rawFrame.result_summary);
    events.push({
      kind: "task_ended",
      taskId,
      status: mapTaskEndStatus(asString(rawFrame.outcome)),
      ...(summary === undefined ? {} : { summary }),
    });
  }
}

export function projectInteractionEvent(
  state: KapProjectionState,
  agentId: string,
  rawFrame: JsonRecord,
  options: KapProjectionOptions,
  events: RuntimeEventBody[],
): { readonly skipFrame?: true; readonly pendingInteraction?: KapPendingInteraction; readonly endedInteractionId?: string } {
  const interactionId = asString(rawFrame.interaction_id);
  if (interactionId === undefined) { return {}; }
  const status = asString(rawFrame.status);
  const kind: "approval" | "question" = asString(rawFrame.kind) === "question" ? "question" : "approval";
  const toolCallId = asString(rawFrame.tool_call_id);
  if (status === "pending" && !state.seenPendingInteractions.has(interactionId)) {
    state.seenPendingInteractions.add(interactionId);
    return {
      skipFrame: true,
      pendingInteraction: {
        interactionId,
        kind,
        agentId,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        native: rawFrame,
      },
    };
  }
  if (status === "ended") {
    const outcome = asString(rawFrame.outcome);
    if ((outcome === "cancelled" || outcome === "canceled") && options.pendingToAppInteractions?.has(interactionId) === true) {
      events.push({ kind: "app_request_cancelled", requestId: interactionId });
    }
    return { endedInteractionId: interactionId };
  }
  return {};
}
