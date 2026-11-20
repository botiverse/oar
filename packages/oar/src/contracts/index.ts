export type { CompactionOptions, CompactionOutcome, ManualCompaction } from "./compaction.js";
export type { GoalControl, AdapterGoalControl, GoalSnapshot, GoalStatus, KnownGoalStatus, GoalSetOptions } from "./goal.js";
export type { InventoryScope, InventoryOptions, SkillEntry, CommandEntry, McpServerEntry, ToolEntry, InventoryResult, InventoryReader, RuntimeInventories } from "./inventory.js";
export type { Probe, OrientOptions, OrientationDepth, Orientation, RuntimeOrientation, Customization } from "./orientation.js";

export type {
  AccountLimitReset,
  AccountLimitResets,
  LimitResetInspection,
  LimitResetInspectOptions,
  LimitResetInspector,
  LimitResetKindStatus,
  LimitResetNotAttemptedReason,
  LimitResetOptions,
  LimitResetRedeemer,
  LimitResetResult,
  LimitResetStartupDiagnostic,
  LimitResetStartupFailed,
  LimitResetStartupScreen,
  LimitResetUnsupportedReason,
  AccountUsageUnsupportedReason,
  AccountUsageUnavailableReason,
  AccountUsageReauthReason,
  AccountUsageReader,
  AccountUsageReadOptions,
  AccountUsageSnapshot,
  AccountUsageWindow,
  AccountUsageWindowScope,
  UtcInstant,
} from "./account-usage.js";
export type {
  AvailableInstallation,
  BundledInstallation,
  ExecutableInstallation,
  InstallationProbe,
  InstallationProbeOptions,
  InstallationSnapshot,
  VersionUnsupportedInstallation,
} from "./installation.js";
export type {
  LoginProvider,
  LoginProviderMethod,
  ProviderAuthFacade,
  ProviderAuthStatus,
  ProviderAuthReader,
  ProviderAuthReadOptions,
  ProviderLoginEvent,
  ProviderLoginInteraction,
  ProviderLoginMethod,
  ProviderLoginOptions,
  ProviderLoginPrompt,
} from "./provider-auth.js";
export type {
  CatalogModel,
  CatalogProvider,
  CatalogRefreshOptions,
  CatalogRefreshResult,
  ModelCatalogFacade,
} from "./model-catalog.js";
export type {
  ListModelsOptions,
  ListModelsResult,
  ModelEntry,
  ModelLister,
} from "./list-models.js";
export type {
  InstallLine,
  InstallOptions,
  InstallPlan,
  InstallPlanner,
  InstallResult,
  InstallStep,
  InstallUnsupported,
  InstallUnsupportedReason,
  Installer,
} from "./install.js";
export type {
  UpdateCheck,
  UpdateChecker,
  UpdateCheckOptions,
  UpdateCheckUnavailableReason,
  Upgrader,
  UpgradeOptions,
  UpgradeResult,
} from "./update.js";
export type {
  AuthStatus,
  AuthStatusOptions,
  AuthStatusReader,
  LastAccount,
  LoginAccount,
  LoginFailureReason,
  LoginOptions,
  LoginResult,
  LoginUnsupportedReason,
  LogoutFailureReason,
  LogoutOptions,
  LogoutResult,
  RuntimeLogin,
  RuntimeLogout,
} from "./login.js";
export type { CompactionEvents, CredentialStore, CredentialVariable, McpToolsListChanged, RefusableSessionOption, RefusedSessionOptions, ResumeOptionSemantics, ResumedSessionOptions, Runtime, RuntimeCredentials, RuntimePlatform, SessionCapabilityDeclaration } from "./runtime.js";
export type { ModelRequest } from "./model-request.js";
export type { ContextUsageCapability } from "./context-usage.js";
export type { McpTransport } from "./session-options.js";
export type {
  AdapterSession,
  AttributionTier,
  CacheWriteByTtl,
  ContextBreakdown,
  ContextCategory,
  ContextItem,
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
  CredentialProblem,
  FailedTurn,
  FailureClass,
  Frame,
  FrameBody,
  DeliverMergeInput,
  DeliverMergeResult,
  DeliverOptions,
  DeliverResult,
  DeliverWhen,
  InputImage,
  InputOptions,
  PromptOptions,
  InputOrigin,
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
  McpServer,
  SessionFork,
  SessionOptions,
  UserConfigurationCategory,
  RawEvent,
  SessionResources,
  SessionUsage,
  StartSession,
  SteerOrQueueResult,
  TaskEventBody,
  TaskStatus,
  TaskType,
  TokenTotals,
  FileChange,
  ToolOutputPart,
  TurnOutcome,
  Unsubscribe,
  UsageReport,
} from "./session.js";
export { defineRuntime, installedSessionCapabilities } from "./runtime.js";
export { UnsupportedOptionError } from "./errors.js";
export { ModelConfirmationError } from "./model-confirmation-error.js";
export { ResumeCwdError, type ResumeCwdReason } from "./resume-cwd-error.js";
export { SessionNotFoundError } from "./session-not-found-error.js";
export { SessionUnavailableError, type SessionUnavailableReason } from "./session-unavailable-error.js";
export { RuntimeFailureError, type RuntimeFailureCode } from "./runtime-failure-error.js";
export { UserShellEnvironmentError } from "./shell-environment.js";
export type { UserShellEnvironment, UserShellEnvironmentOptions, UserShellEnvironmentFailure } from "./shell-environment.js";

export type { PlacementRequest, SessionPlacement, SessionOpenContext, SessionCleanup, SessionRelease, RuntimePlacementOptions } from "./placement.js";

export type { SideQuestionOptions } from "./side-question.js";
