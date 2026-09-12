import { RuntimeRegistry } from "./registry.js";
import { claudeRuntime } from "./runtimes/claude/index.js";
import { codexRuntime } from "./runtimes/codex/index.js";
import { grokRuntime } from "./runtimes/grok/index.js";
import { kimiRuntime } from "./runtimes/kimi/index.js";
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
export type {
  ProviderAuthFacade,
  ProviderAuthStatus,
  ProviderLoginEvent,
  ProviderLoginInteraction,
  ProviderLoginMethod,
  ProviderLoginPrompt,
} from "./contracts/provider-auth.js";
export type {
  CatalogModel,
  CatalogProvider,
  CatalogRefreshOptions,
  CatalogRefreshResult,
  ModelCatalogFacade,
} from "./contracts/model-catalog.js";
export type {
  ListModelsOptions,
  ListModelsResult,
  ModelEntry,
  ModelLister,
} from "./contracts/list-models.js";
export type { Runtime } from "./contracts/runtime.js";
export type {
  AdapterSession,
  AttributionTier,
  ContextUsage,
  ControlResult,
  Cursor,
  EventBody,
  EventRecord,
  EventView,
  FailureClass,
  PromptLineage,
  PromptOptions,
  QueryResult,
  ReasoningContent,
  RecordEnvelope,
  RecordKind,
  RequestBody,
  RequestDirection,
  RequestRecord,
  ResponseBody,
  ResponseRecord,
  Session,
  SessionCapabilities,
  SessionEdge,
  SessionGraph,
  SessionNode,
  SessionObserver,
  SessionOptions,
  SessionRecord,
  SessionUsage,
  StartSession,
  SteerOrQueueResult,
  TokenTotals,
  TurnOutcome,
  Unsubscribe,
  UsageReport,
} from "./contracts/session.js";
export { defineRuntime } from "./contracts/runtime.js";
export { utcInstantFromDate } from "./shared/instant.js";
export { RuntimeRegistry, createRuntimeRegistry } from "./registry.js";
export {
  VOYAGE_FORMAT,
  endLine,
  headerLine,
  openVoyage,
  recordLine,
} from "./voyage.js";
export type { VoyageHeader, VoyageRecorder } from "./voyage.js";
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
export { classifyTool, toolActionLabel } from "./observe/tool-activity.js";
export type { ToolAction, ToolActionKind } from "./observe/tool-activity.js";
export type { AgentObserver, AgentView, ObserveAgentOptions } from "./observe/observe-agent.js";
export { awaitTurnEnd, promptAndWait, turnEndAfter } from "./observe/turns.js";
export type { PromptRun } from "./observe/turns.js";
export { contextUsageOf, modelOf, usageOf } from "./observe/usage.js";
export { claudeRuntime } from "./runtimes/claude/index.js";
export { claudeListModels, projectClaudeModels } from "./runtimes/claude/list-models.js";
export { claudeSession } from "./runtimes/claude/session.js";
export { claudeInstallation } from "./runtimes/claude/installation.js";
export { codexRuntime } from "./runtimes/codex/index.js";
export { codexListModels, projectCodexModels } from "./runtimes/codex/list-models.js";
export { codexSession } from "./runtimes/codex/session.js";
export { codexInstallation } from "./runtimes/codex/installation.js";
export { createPiProviderAuth } from "./runtimes/pi/auth.js";
export type { PiProviderAuthOptions } from "./runtimes/pi/auth.js";
export { createPiModelCatalog } from "./runtimes/pi/catalog.js";
export type { PiModelCatalogOptions } from "./runtimes/pi/catalog.js";
export { grokRuntime } from "./runtimes/grok/index.js";
export { grokListModels, projectGrokModels } from "./runtimes/grok/list-models.js";
export { grokSession } from "./runtimes/grok/session.js";
export { grokInstallation } from "./runtimes/grok/installation.js";
export { kimiRuntime } from "./runtimes/kimi/index.js";
export { kimiListModels, projectKimiModels } from "./runtimes/kimi/list-models.js";
export { kimiSession } from "./runtimes/kimi/session.js";
export { kimiInstallation } from "./runtimes/kimi/installation.js";
export { piRuntime } from "./runtimes/pi/index.js";
export { piListModels, projectPiModels } from "./runtimes/pi/list-models.js";
export { piSession } from "./runtimes/pi/session.js";
export { piInstallation } from "./runtimes/pi/installation.js";

export const runtimes = new RuntimeRegistry([
  claudeRuntime,
  codexRuntime,
  grokRuntime,
  kimiRuntime,
  piRuntime,
]);
