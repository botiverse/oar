import { RuntimeRegistry } from "./registry.js";
import { claudeRuntime } from "./runtimes/claude/index.js";
import { codexRuntime } from "./runtimes/codex/index.js";
import { piRuntime } from "./runtimes/pi/index.js";

export type {
  AccountUsageReader,
  AccountUsageReadOptions,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from "./contracts/account-usage.js";
export type {
  AvailableInstallation,
  BundledInstallation,
  ExecutableInstallation,
  InstallationProbe,
  InstallationSnapshot,
} from "./contracts/installation.js";
export type { RunResult, Runtime, RuntimeSpec } from "./contracts/runtime.js";
export type {
  AdapterSession,
  PromptResult,
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
export { defineRuntime } from "./shared/define-runtime.js";
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
export { claudeRuntime } from "./runtimes/claude/index.js";
export { codexRuntime } from "./runtimes/codex/index.js";
export { piRuntime } from "./runtimes/pi/index.js";

export const runtimes = new RuntimeRegistry([claudeRuntime, codexRuntime, piRuntime]);
