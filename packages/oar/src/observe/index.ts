/**
 * Browser-safe observe subpath: the pure derivation utilities over
 * RawEvents, with ZERO Node and ZERO adapter imports. A renderer can
 * value-import `@botiverse/oar/observe` directly without dragging the runtime
 * adapters (node:child_process, the pi SDK, …) into a browser bundle. The
 * root `@botiverse/oar` re-exports these too, for Node consumers.
 */
export { eventsOf } from "./events.js";
export { graphOf } from "./graph.js";
export type { KnownControl } from "./events.js";
export { initialStatus, reduceStatus, statusOf } from "./agent-status.js";
export type { AgentStatus, RunningPhase, StatusState } from "./agent-status.js";
export { observeStalls } from "./stall-observer.js";
export type { StallInfo } from "./stall-observer.js";
export { observeAgent, simpleStateOf } from "./observe-agent.js";
export type { AgentObserver, AgentView, ObserveAgentOptions } from "./observe-agent.js";
export { classifyTool, toolActionLabel } from "./tool-activity.js";
export { groupToolActivity, toolGroupSummary } from "./tool-groups.js";
export { failureText, noticeText, noticeTone, phaseLabel, taskStatusLabel } from "./display-text.js";
export { failureAdvice } from "./failure-advice.js";
export type { FailureAdvice } from "./failure-advice.js";
export type { NoticeTone } from "./display-text.js";
export { toolResultText } from "./tool-output.js";
export { appRequestKind, appRequestText } from "./app-requests.js";
export { redactRecord } from "./redact-record.js";
export { REDACTION_RULES } from "../shared/credential-redaction.js";
export type { AppRequestKind } from "./app-requests.js";
export type { ToolAction, ToolActionKind } from "./tool-activity.js";
export type { ReasoningPart, ToolGroup, ToolGroupSegment, ToolPart } from "./tool-groups.js";
export { awaitIdle, awaitTurnEnd, promptAndWait, turnEndAfter } from "./turns.js";
export type { PromptRun, PromptRunOptions, InputHandled } from "./turns.js";
export { contextUsageOf, usageOf } from "./usage.js";
export { initialTaskState, reduceTasks, reduceTaskState, tasksOf } from "./tasks.js";
export type { TaskMap, TaskState, TaskView } from "./tasks.js";

export { initialConversation, reduceConversation } from "./conversation.js";
export type { ConversationState, ConversationInput, ConversationUpdate, InputAttempt, InputDisposition } from "./conversation.js";

export { initialSessionView, reduceSessionView } from "./session-view.js";
export type {
  SessionView,
  ViewMessage,
  ViewTurn,
  ViewActivity,
  ViewSection,
  ViewPart,
  ViewNotice,
  PendingRequest,
} from "./session-view.js";
