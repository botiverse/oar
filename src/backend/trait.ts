import type { IdleSession, StopMode } from "../session/handle.js";
import type { Capabilities } from "../capability.js";
import type { ConfigSchema } from "../config/options.js";
import type { ModelInfo } from "../config/model.js";
import type { RuntimeEvent } from "../events/event.js";

/**
 * What a DRIVER implements. Consumers never see this.
 *
 * Two layers on purpose: an ergonomic public API for consumers, and this raw
 * trait for backends. Mechanism then has nowhere to leak to -- a consumer
 * cannot accidentally depend on stdin-vs-SDK, because the type carrying that
 * distinction is not exported to them.
 *
 * A driver declares WHAT it needs; oar performs HOW. Spawning, awaiting
 * readiness, graceful→force escalation, reaping, timeouts and the Windows
 * branch are identical work for every runtime and are therefore written once,
 * not re-paid per adapter.
 *
 * ── UNIFORM BY CONSTRUCTION ─────────────────────────────────────────────────
 * The execution-kind (subprocess vs in-process SDK) is INVISIBLE here. A host
 * sees only `start()` + `normalise()`. Whether a runtime is a child process or
 * an in-process SDK is absorbed by WHICH construction path built the driver:
 *   - subprocess runtimes are built via `subprocessDriver({ plan, readiness,
 *     shutdown, normalise, ... })` — `plan`/`LaunchSpec`/`ProcessHost` live
 *     there now, as the mid-layer's internals, not on this contract;
 *   - in-process runtimes (pi) build a `RuntimeDriver` directly, with a
 *     `start()` that spins up an SDK-backed session and never touches a process.
 */
export interface RuntimeDriver {
  readonly id: string;

  /**
   * Installed on this host? Which version?
   * `null` = genuinely absent. May throw (caught by detectAll as detect_failed).
   */
  detect(): Promise<{ readonly version: string } | null>;

  /** Dynamic model list plus each model's options. One call covers every model. */
  models(): Promise<readonly ModelInfo[]>;

  /**
   * Optional provider axis (e.g. pi). When present, schema uses provider→model
   * and models() may return [] (providers own the lists).
   */
  providers?(): Promise<readonly import("../config/model.js").ProviderInfo[]>;

  /**
   * Declaration, not behaviour: what this runtime can do and must be told.
   * Config path does NOT depend on this member (models() → support is the source).
   * Whether the member stays is a runtime-interface question outside the config cut.
   */
  describe(resolution: { readonly version: string; readonly model?: string }): Promise<Declaration>;

  /**
   * Start a drivable session. Resolves ONLY once the runtime is genuinely READY
   * — the declared readiness witness has been observed — never merely spawned.
   * There is deliberately no path to an `IdleSession` that skips readiness: a
   * caller cannot obtain a drivable handle for a process that started but never
   * became usable.
   *
   * How readiness is awaited, how a subprocess is spawned (via the shared
   * `ProcessHost`) or how an SDK is created is the construction path's business,
   * not this contract's.
   */
  start(options: Readonly<Record<string, string>>): Promise<IdleSession>;

  /** Turn transport-specific traffic into contract events. */
  normalise(raw: unknown): readonly RuntimeEvent[];
}

export interface Declaration {
  readonly capabilities: Capabilities;
  readonly config: ConfigSchema;
}

/**
 * READINESS — the axis that exists because "started" has repeatedly meant
 * "spawned", and a spawn that comes up inert then looks like a success.
 *
 * ⚠️ `process_spawned` is offered and is almost always the WRONG answer. It is
 * present because some runtimes genuinely offer nothing better, and naming it
 * makes that weakness visible in the driver's declaration instead of hiding it
 * behind a start() that returns cheerfully.
 */
export type Readiness =
  /** The runtime emits an explicit ready/handshake event. Strongest. */
  | { readonly kind: "handshake_event" }
  /** Nothing is ready until the first turn produces a contract event. */
  | { readonly kind: "first_event"; readonly withinMs: number }
  /**
   * ⚠️ Weakest: the child process exists. Cannot distinguish "running" from
   * "running and inert" -- which is precisely the failure this project keeps
   * paying for. A driver declaring this is declaring a known blind spot.
   */
  | { readonly kind: "process_spawned" };

/**
 * SHUTDOWN — declared per runtime, executed by oar.
 *
 * The driver states what it needs (a goodbye message first? a grace period?);
 * the escalation policy itself is oar's, so thirteen runtimes cannot each
 * invent a slightly different one. No signal names appear here: a signal has
 * no Windows equivalent, and putting one in the contract would make adding a
 * platform a contract change.
 */
export interface ShutdownProtocol {
  /**
   * Send this before asking the process to end, when the runtime expects to be
   * told. Absent when it does not care.
   */
  readonly farewell?: { readonly text: string };
  /** How long a graceful stop is given before force is applied. */
  readonly graceMs: number;
  /**
   * What a `graceful` request degrades to when the grace period elapses.
   * Stated explicitly because a silent degrade is how "stop" becomes
   * "sometimes stop".
   */
  readonly onGraceExpiry: StopMode;
}

/**
 * Empty capability/config declaration — the honest default for a driver that
 * declares nothing extra. Shared so each construction path (subprocessDriver,
 * the direct pi driver) does not re-invent a subtly different one.
 */
export const emptyDeclaration = async (): Promise<Declaration> => ({
  capabilities: { steer: false, interrupt: false, resume: false, interceptToolCalls: false },
  config: { options: [], unsupported: [] },
});
