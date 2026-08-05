/**
 * oar — an agent client access layer.
 *
 * THIS FILE IS THE CONSUMER SURFACE. Everything exported here is safe for a
 * host that wants to drive a runtime. Implementor-side machinery (process
 * management, backend traits, middleware) lives under `backend/` and is
 * deliberately NOT re-exported: a consumer sees a session and typed events,
 * never a process and never a raw stderr pipe.
 */

// Capabilities -- what you may DO while driving a session.
export type { Capabilities, CapabilitySource } from "./capability.js";

// Config options -- what you FILL IN before starting. A separate record on
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

// Events -- observation only. Interception (can the host say no?) is a
// separate contract under events/intercept.ts.
export type { RuntimeEvent, TurnEndReason } from "./events/event.js";
export { describeEvent } from "./events/event.js";
export { Diagnostic } from "./events/diagnostic.js";
export type { DiagnosticClass } from "./events/diagnostic.js";

// Sessions -- state lives in the type, so illegal operations do not compile.
export type {
  BusySession,
  ClosedSession,
  IdleSession,
  Session,
  SteerableSession,
  StopMode,
} from "./session/handle.js";
export { steerable } from "./session/handle.js";
