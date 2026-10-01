import { RuntimeRegistry } from "./registry.js";
import { antigravityRuntime } from "./runtimes/antigravity/index.js";
import { claudeRuntime } from "./runtimes/claude/index.js";
import { codexRuntime } from "./runtimes/codex/index.js";
import { cursorRuntime } from "./runtimes/cursor/index.js";
import { grokRuntime } from "./runtimes/grok/index.js";
import { kimiRuntime } from "./runtimes/kimi/index.js";
import { piRuntime } from "./runtimes/pi/index.js";

export type { InventoryScope, InventoryOptions, SkillEntry, McpServerEntry, ToolEntry, InventoryResult, InventoryReader, RuntimeInventories } from "./contracts/inventory.js";

export type {
  AccountUsageUnsupportedReason,
  AccountUsageReauthReason,
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
export type {
  UpdateCheck,
  UpdateChecker,
  UpdateCheckOptions,
  UpdateCheckUnavailableReason,
  Upgrader,
  UpgradeOptions,
  UpgradeResult,
} from "./contracts/update.js";
export type { Runtime } from "./contracts/runtime.js";
export type {
  AdapterSession,
  AttributionTier,
  ContextUsage,
  ControlAction,
  ControlEventBody,
  ControlOutcome,
  ControlResult,
  Cursor,
  Event,
  EventBody,
  EventObserver,
  EventsOptions,
  FailureClass,
  Frame,
  FrameBody,
  InputImage,
  InputOptions,
  QueryResult,
  ReasoningContent,
  RecordEnvelope,
  RecordKind,
  RejectionCode,
  RequestBody,
  RequestDirection,
  RequestRecord,
  ResponseBody,
  ResponseRecord,
  RuntimeEventBody,
  UserMessage,
  Session,
  SessionCapabilities,
  SessionEdge,
  SessionGraph,
  SessionNode,
  RawEventObserver,
  SessionOptions,
  RawEvent,
  SessionUsage,
  StartSession,
  SteerOrQueueResult,
  TaskEventBody,
  TaskStatus,
  TaskType,
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
export { coalesceText, controlActionsOf, eventsOf, eventsReader } from "./observe/events.js";
export {
  initialStatus,
  reduceStatus,
  stallOf,
  statusOf,
} from "./observe/agent-status.js";
export type { AgentStatus, RunningPhase } from "./observe/agent-status.js";
export { observeStalls } from "./observe/stall-observer.js";
export type { StallInfo } from "./observe/stall-observer.js";
export { observeAgent, simpleStateOf } from "./observe/observe-agent.js";
export { classifyTool, toolActionLabel } from "./observe/tool-activity.js";
export type { ToolAction, ToolActionKind } from "./observe/tool-activity.js";
export type { AgentObserver, AgentView, ObserveAgentOptions } from "./observe/observe-agent.js";
export { applyTaskEvent, initialTasks, reduceTasks, tasksOf } from "./observe/tasks.js";
export type { TaskEventOrigin, TaskMap, TaskView } from "./observe/tasks.js";
export { awaitIdle, awaitTurnEnd, promptAndWait, turnEndAfter } from "./observe/turns.js";
export type { PromptRun, PromptRunOptions } from "./observe/turns.js";
export { contextUsageOf, effortOf, modelOf, usageOf } from "./observe/usage.js";
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
export { antigravityRuntime } from "./runtimes/antigravity/index.js";
export { antigravitySession } from "./runtimes/antigravity/session.js";
export { antigravityInstallation } from "./runtimes/antigravity/installation.js";
export { antigravityListModels, projectAntigravityModels } from "./runtimes/antigravity/list-models.js";
export { cursorRuntime } from "./runtimes/cursor/index.js";
export { cursorListModels, projectCursorModels } from "./runtimes/cursor/list-models.js";
export { cursorSession } from "./runtimes/cursor/session.js";
export { cursorInstallation } from "./runtimes/cursor/installation.js";
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
  antigravityRuntime,
  claudeRuntime,
  codexRuntime,
  cursorRuntime,
  grokRuntime,
  kimiRuntime,
  piRuntime,
]);

export { runtimeBrands, runtimeBrandIcon } from "./brands.js";
export type { RuntimeBrand } from "./brands.js";

export { initialConversation, reduceConversation, conversationOf, observeConversation } from "./observe/conversation.js";
export type { ConversationState, ConversationInput, ConversationUpdate, InputAttempt } from "./observe/conversation.js";
