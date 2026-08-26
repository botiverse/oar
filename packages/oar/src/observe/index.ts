/**
 * Browser-safe observe subpath: the pure derivation utilities over
 * SessionEvents, with ZERO Node and ZERO adapter imports. A renderer can
 * value-import `@botiverse/oar/observe` directly without dragging the runtime
 * adapters (node:child_process, the pi SDK, …) into a browser bundle. The
 * root `@botiverse/oar` re-exports these too, for Node consumers.
 */
export { aggregateDeltas } from "./aggregate-events.js";
export { initialStatus, reduceStatus, stallOf } from "./agent-status.js";
export type { AgentStatus, RunningPhase } from "./agent-status.js";
export { observeStalls } from "./stall-observer.js";
export type { StallInfo } from "./stall-observer.js";
export { observeAgent, simpleStateOf } from "./observe-agent.js";
export type { AgentObserver, AgentView, ObserveAgentOptions } from "./observe-agent.js";
export { classifyTool, toolActionLabel } from "./tool-activity.js";
export type { ToolAction, ToolActionKind } from "./tool-activity.js";
