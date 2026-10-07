/**
 * Browser-safe observe subpath: the pure derivation utilities over
 * RawEvents, with ZERO Node and ZERO adapter imports. A renderer can
 * value-import `@botiverse/oar/observe` directly without dragging the runtime
 * adapters (node:child_process, the pi SDK, …) into a browser bundle. The
 * root `@botiverse/oar` re-exports these too, for Node consumers.
 */
export { coalesceText, controlActionsOf, eventsOf, eventsReader } from "./events.js";
export type { KnownControl } from "./events.js";
export { initialStatus, reduceStatus, stallOf, statusOf } from "./agent-status.js";
export type { AgentStatus, RunningPhase } from "./agent-status.js";
export { observeStalls } from "./stall-observer.js";
export type { StallInfo } from "./stall-observer.js";
export { observeAgent, simpleStateOf } from "./observe-agent.js";
export type { AgentObserver, AgentView, ObserveAgentOptions } from "./observe-agent.js";
export { classifyTool, toolActionLabel } from "./tool-activity.js";
export { groupToolActivity, toolGroupSummary } from "./tool-groups.js";
export { toolResultText } from "./tool-output.js";
export { appRequestKind } from "./app-requests.js";
export { redactRecord } from "./redact-record.js";
export { REDACTION_RULES } from "../shared/credential-redaction.js";
export type { AppRequestKind } from "./app-requests.js";
export type { ToolAction, ToolActionKind } from "./tool-activity.js";
export type { ReasoningPart, ToolGroup, ToolGroupSegment, ToolPart } from "./tool-groups.js";
export { awaitIdle, awaitTurnEnd, promptAndWait, turnEndAfter } from "./turns.js";
export type { PromptRun, PromptRunOptions } from "./turns.js";
export { contextUsageOf, effortOf, modelOf, usageOf } from "./usage.js";
export { applyTaskEvent, initialTasks, reduceTasks, tasksOf } from "./tasks.js";
export type { TaskEventOrigin, TaskMap, TaskView } from "./tasks.js";

export { initialConversation, reduceConversation, conversationOf, observeConversation } from "./conversation.js";
export type { ConversationState, ConversationInput, ConversationUpdate, InputAttempt } from "./conversation.js";

export {
  initialSessionView,
  reduceSessionView,
  reduceSessionViewEvent,
  reduceSessionViewInput,
  viewOf,
  observeSessionView,
} from "./session-view.js";
export type {
  SessionView,
  ViewMessage,
  ViewTurn,
  ViewSection,
  ViewPart,
  ViewNotice,
  PendingRequest,
} from "./session-view.js";
