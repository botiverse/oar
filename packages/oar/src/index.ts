import { RuntimeRegistry } from "./registry.js";
import { claudeRuntime } from "./runtimes/claude/index.js";
import { codexRuntime } from "./runtimes/codex/index.js";
import { piRuntime } from "./runtimes/pi/index.js";

export type {
  AccountUsageReader,
  AccountUsageReadOptions,
  AccountUsageSnapshot,
  AccountUsageWindow,
  UtcInstant,
} from "./contracts/account-usage.js";
export type {
  AvailableInstallation,
  BundledInstallation,
  ExecutableInstallation,
  InstallationProbe,
  InstallationSnapshot,
} from "./contracts/installation.js";
export type { Runtime } from "./contracts/runtime.js";
export type {
  AdapterSession,
  PromptResult,
  ReasoningContent,
  Session,
  SessionEvent,
  SessionEventBody,
  SessionEventEnvelope,
  SessionObserver,
  SessionOptions,
  StartSession,
  SteerOrQueueResult,
  SteerResult,
  Turn,
  TurnOutcome,
  TurnQueue,
  Unsubscribe,
} from "./contracts/session.js";
export { defineRuntime } from "./contracts/runtime.js";
export { utcInstantFromDate } from "./shared/instant.js";
export { RuntimeRegistry, createRuntimeRegistry } from "./registry.js";
export { aggregateDeltas } from "./observe/aggregate-events.js";
export {
  initialStatus,
  reduceStatus,
  stallOf,
} from "./observe/agent-status.js";
export type { AgentStatus, RunningPhase } from "./observe/agent-status.js";
export { observeStalls } from "./observe/stall-observer.js";
export type { StallInfo } from "./observe/stall-observer.js";
export { observeAgent, simpleStateOf } from "./observe/observe-agent.js";
export type { AgentObserver, AgentView, ObserveAgentOptions } from "./observe/observe-agent.js";
export { claudeRuntime } from "./runtimes/claude/index.js";
export { claudeSession } from "./runtimes/claude/session.js";
export { claudeInstallation } from "./runtimes/claude/installation.js";
export { codexRuntime } from "./runtimes/codex/index.js";
export { codexSession } from "./runtimes/codex/session.js";
export { codexInstallation } from "./runtimes/codex/installation.js";
export { piRuntime } from "./runtimes/pi/index.js";
export { piSession } from "./runtimes/pi/session.js";
export { piInstallation } from "./runtimes/pi/installation.js";

export const runtimes = new RuntimeRegistry([claudeRuntime, codexRuntime, piRuntime]);
