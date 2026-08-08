/**
 * oar — an agent client access layer.
 *
 * THIS FILE IS THE CONSUMER SURFACE. Everything exported here is safe for a
 * host that wants to drive a runtime. Implementor-side machinery (process
 * management, backend traits, middleware) lives under `backend/` and is
 * deliberately NOT re-exported: a consumer sees a session and typed events,
 * never a process and never a raw stderr pipe.
 */

// Capabilities: what you may DO while driving a session.
export type { Capabilities, CapabilitySource } from "./capability.js";

// Config options: what you FILL IN before starting. A separate record on
// purpose; see docs/ARCHITECTURE.md for why fusing the two loses a question.
export type {
  AuthOption,
  BooleanOption,
  ConfigOption,
  ConfigSchema,
  EnumOption,
  OptionResolution,
} from "./config/options.js";
export type { AuthMode, CredentialRef, ResolvedAuth } from "./config/auth.js";

// Launch-config form surface (create-agent). Clients still import nothing —
// they consume JSON Schema over the wire. Server/host import these.
export type {
  Choice,
  ConfigOption as ModelConfigOption,
  ModelInfo,
  ModelBranch,
  ProviderInfo,
} from "./config/model.js";
export { optionsBranch, enumOpt, boolOpt, model } from "./config/model.js";
export type { FormSchemaResult } from "./config/schema.js";
export { buildFormSchema, authSubschema, snapshotIdOf } from "./config/schema.js";
export type { RuntimeConfig, ValidationError, ValidateConfigInput } from "./config/validate.js";
export { validateConfig, ConfigError } from "./config/validate.js";
export {
  PROFILE_KEYWORDS,
  effectiveSchema,
  matches,
  checkAgainstProfile,
  assertInProfile,
  profileViolations,
  ProfileError,
  ConfigCheckError,
} from "./config/profile.js";
export type { JsonSchema, EffectiveSchema, ConfigCheckCode } from "./config/profile.js";
export type { DetectFailure, RuntimeDescriptor } from "./discovery/detect.js";
export { detectAll, detectAllRegistered } from "./discovery/detect.js";
export {
  fixtureDescriptors,
  creatableDescriptors,
  deprecatedExcluded,
  assertFixtureCoversRegistry,
  RAFT_DRIVER_REGISTRY,
  RAFT_DEPRECATED_FOR_CREATE,
} from "./discovery/fixtures/raftRuntimes.js";

// Events: observation only. Interception (can the host say no?) is a
// separate contract under events/intercept.ts.
export type { RuntimeEvent, TurnEndReason } from "./events/event.js";
export { describeEvent } from "./events/event.js";
export { Diagnostic } from "./events/diagnostic.js";
export type { DiagnosticClass } from "./events/diagnostic.js";

// Sessions: state lives in the type, so illegal operations do not compile.
export type {
  BusySession,
  ClosedSession,
  IdleSession,
  Session,
  SteerableSession,
  StopMode,
} from "./session/handle.js";
export { steerable } from "./session/handle.js";
export type { TokenUsage, UsageReport, UsageScope } from "./events/usage.js";
export { addUsage } from "./events/usage.js";
export type { Liveness, NoProgressDeadline, Progress, Staleness, Subject } from "./events/progress.js";
export { resets } from "./events/progress.js";
