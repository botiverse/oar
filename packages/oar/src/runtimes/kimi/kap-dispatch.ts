import { createAbortFallback } from "../../shared/abort-fallback.js";
import { asRecordList, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import { scheduleDrainHeld, type KapRuntimeState } from "./kap-controls.js";
import { ignoreRejection } from "./kap-errors.js";
import type { KapNegotiationResult } from "./kap-open.js";
import {
  projectKapFrame,
  type KapProjectedFrame,
  type KapProjectionState,
  type KapTurnRef,
} from "./kap-projection.js";
import { kapRequest } from "./kap-protocol.js";

export function createRuntimeState(
  opened: Extract<KapNegotiationResult, { readonly kind: "ready" }>,
  activeKernel: SessionKernel,
  taskAgentById: Map<string, string>,
  compactionBusy: () => boolean,
): KapRuntimeState {
  return {
    sessionId: opened.sessionId,
    endpoint: opened.endpoint,
    socket: opened.socket,
    kernel: activeKernel,
    abortFallback: createAbortFallback(() => {
      opened.child.kill();
    }, 10_000),
    taskAgentById,
    held: [],
    pendingSteers: [],
    observedRootPromptIds: new Set(),
    compactionBusy,
    activeRootTurn: null,
    rootTurnEpoch: 0,
    awaitingTurnStart: false,
    abortRequested: false,
    prompting: false,
    dispatching: false,
    drainScheduled: false,
  };
}

function settlePendingSteersOnTurnStart(state: KapRuntimeState, opened: KapTurnRef): void {
  if (opened.steeredFromPromptId !== undefined) {
    state.observedRootPromptIds.add(opened.steeredFromPromptId);
  }
  for (let i = state.pendingSteers.length - 1; i >= 0; i -= 1) {
    const entry = state.pendingSteers[i];
    if (entry === undefined) { continue; }
    const matchedPrompt = opened.steeredFromPromptId !== undefined && entry.promptId === opened.steeredFromPromptId;
    const matchedParent =
      opened.steeredFromPromptId === undefined &&
      opened.steeredFromTurnId !== undefined &&
      entry.parentTurnId === opened.steeredFromTurnId;
    if (matchedPrompt || matchedParent) {
      state.pendingSteers.splice(i, 1);
    } else {
      entry.parentTurnId ??= opened.turnId;
    }
  }
}

function recordObservedRootPrompts(state: KapRuntimeState, promptIds: readonly string[]): void {
  for (const pid of promptIds) {
    state.observedRootPromptIds.add(pid);
    for (let i = state.pendingSteers.length - 1; i >= 0; i -= 1) {
      if (state.pendingSteers[i]?.promptId === pid) {
        state.pendingSteers.splice(i, 1);
      }
    }
  }
}

function trackTaskAgents(taskAgentById: Map<string, string>, rawFrame: JsonRecord): void {
  if (rawFrame.type === "task" && typeof rawFrame.task_id === "string") {
    const agent = typeof rawFrame.agent_id === "string" ? rawFrame.agent_id : "main";
    taskAgentById.set(rawFrame.task_id, agent);
    return;
  }
  if (rawFrame.type === "task.list") {
    for (const task of asRecordList(rawFrame.tasks)) {
      if (typeof task.task_id !== "string") { continue; }
      const agent = typeof task.agent_id === "string" ? task.agent_id : "main";
      taskAgentById.set(task.task_id, agent);
    }
  }
}

async function answerInteraction(
  state: KapRuntimeState,
  pendingToApp: Set<string>,
  pending: NonNullable<KapProjectedFrame["pendingInteraction"]>,
): Promise<void> {
  if (state.kernel.unreachable() !== null) { return; }
  const payload: JsonRecord = pending.kind === "question"
    ? { kind: "question", dismissed: true }
    : { kind: "approval", decision: "approved" };
  try {
    await kapRequest(
      state.endpoint.origin,
      state.endpoint.token,
      `/sessions/${encodeURIComponent(state.sessionId)}/interactions/${encodeURIComponent(pending.interactionId)}`,
      { method: "POST", body: payload, timeoutMs: 10_000 },
    );
    pendingToApp.delete(pending.interactionId);
    if (state.kernel.unreachable() === null) {
      state.kernel.respond(pending.interactionId, { kind: "answered", native: payload });
    }
  } catch {
    // Ignore errors when KAP already closed or settled the interaction concurrently.
  }
}

export function processWsFrame(
  projection: KapProjectionState,
  state: KapRuntimeState,
  pendingToApp: Set<string>,
  rawFrame: JsonRecord,
): void {
  trackTaskAgents(state.taskAgentById, rawFrame);
  const projected = projectKapFrame(projection, rawFrame, {
    manualCompactionActive: state.compactionBusy(),
    pendingToAppInteractions: pendingToApp,
  });
  if (projected.rootUserPromptIds !== undefined) {
    recordObservedRootPrompts(state, projected.rootUserPromptIds);
  }
  if (projected.openedTurn !== undefined && projected.openedTurn.agentId === "main") {
    state.rootTurnEpoch += 1;
    state.awaitingTurnStart = false;
    state.abortRequested = false;
    state.activeRootTurn = projected.openedTurn.turnId;
    settlePendingSteersOnTurnStart(state, projected.openedTurn);
  }
  if (projected.endedTurnId !== undefined && (state.activeRootTurn === projected.endedTurnId || (state.awaitingTurnStart && state.activeRootTurn === null))) {
    state.awaitingTurnStart = false;
    state.activeRootTurn = null;
    state.abortFallback.clear();
    if (state.abortRequested || projected.endedTurnOutcome === "failed") {
      state.pendingSteers.length = 0;
    }
    state.abortRequested = false;
    scheduleDrainHeld(state);
  }
  if (projected.endedInteractionId !== undefined) {
    pendingToApp.delete(projected.endedInteractionId);
  }
  if (projected.pendingInteraction !== undefined) {
    const pending = projected.pendingInteraction;
    pendingToApp.add(pending.interactionId);
    state.kernel.request(
      "toApp",
      { kind: "native", type: `interaction/${pending.kind}`, native: pending.native },
      { ...projected.at, id: pending.interactionId },
    );
    void answerInteraction(state, pendingToApp, pending);
  }
  if (projected.subscribeAgents !== undefined && !state.socket.closed()) {
    for (const childAgentId of projected.subscribeAgents) {
      void ignoreRejection(
        state.socket.command({ type: "subscribe", session_id: state.sessionId, agent_ids: [childAgentId] }),
      );
    }
  }
  if (projected.skipFrame !== true) {
    state.kernel.frame(projected.body, projected.at);
  }
}
