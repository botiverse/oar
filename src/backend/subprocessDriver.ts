/**
 * subprocessDriver — the SUBPROCESS MID-LAYER.
 *
 * The top-level `RuntimeDriver` is uniform (start + normalise). Everything that
 * is subprocess-specific — `plan()`, `LaunchSpec`, the shared `ProcessHost`
 * spawn, the readiness wait, graceful→force stop — lives HERE, not on the
 * contract. Subprocess runtimes (codex, and the CLI drivers) are built through
 * this factory; the in-process pi runtime bypasses it (it has no child).
 *
 * The two wins `plan()`/`ProcessHost` exist for are preserved, now scoped to
 * this layer:
 *   - single-enforcement-path: the ONLY spawn goes through the injected
 *     `ProcessHost` (default: the shared node host). A driver cannot self-spawn.
 *   - testable pure `plan()`: config → LaunchSpec without spawning.
 */
import type {
  BusySession,
  ClosedSession,
  IdleSession,
  StopMode,
} from "../session/handle.js";
import type { Capabilities } from "../capability.js";
import type { ModelInfo, ProviderInfo } from "../config/model.js";
import type { RuntimeEvent } from "../events/event.js";
import { emptyDeclaration, type Declaration, type Readiness, type ShutdownProtocol, type RuntimeDriver } from "./runtimeDriver.js";
import type { LaunchSpec, ProcessHandle, ProcessHost } from "./process/lifecycle.js";
import { nodeProcessHost } from "./process/nodeHost.js";

/** Sequential frame access + a send channel, handed to a driver's handshake. */
export interface HandshakeIo {
  send(line: string): void;
  /** The next raw stdout frame, or `null` once the transport closes. */
  next(): Promise<string | null>;
}

/** How a driver writes a prompt onto its transport. */
export interface PromptIo {
  send(line: string): void;
}

const DEFAULT_CAPABILITIES: Capabilities = {
  steer: false,
  interrupt: false,
  resume: false,
  interceptToolCalls: false,
};

const DEFAULT_SHUTDOWN: ShutdownProtocol = { graceMs: 1_000, onGraceExpiry: "immediate" };

export interface SubprocessSpec {
  readonly id: string;

  // ── discovery (same surface baseDriver required) ──────────────────────────
  detect: () => Promise<{ version: string } | null>;
  models: () => Promise<readonly ModelInfo[]>;
  providers?: () => Promise<readonly ProviderInfo[]>;
  describe?: (resolution: { readonly version: string; readonly model?: string }) => Promise<Declaration>;

  // ── subprocess mid-layer internals (all optional; sane defaults) ───────────
  /** config → LaunchSpec. Default: bare `<id>` with no args. */
  plan?: (options: Readonly<Record<string, string>>) => LaunchSpec;
  /** How this runtime proves it is usable. Default: the weak `process_spawned`. */
  readiness?: Readiness;
  shutdown?: ShutdownProtocol;
  /** transport frame → contract events. Default: `() => []`. */
  normalise?: (raw: unknown) => readonly RuntimeEvent[];
  capabilities?: Capabilities;

  /**
   * Perform the readiness handshake over the transport, resolving when the
   * runtime is genuinely ready. REQUIRED when `readiness.kind === "handshake_event"`.
   * Must tolerate unsolicited / out-of-order frames.
   */
  handshake?: (io: HandshakeIo) => Promise<void>;

  /**
   * Write a user prompt onto the transport. When absent, `prompt()` throws:
   * a runtime whose turn protocol is not wired cannot silently pretend to run.
   */
  sendPrompt?: (io: PromptIo, text: string) => void;

  /** Injectable for tests; defaults to the shared node ProcessHost. */
  host?: ProcessHost;
}

interface SessionCtx {
  readonly id: string;
  readonly handle: ProcessHandle;
  readonly reader: { next: () => Promise<string | null> };
  readonly normalise: (raw: unknown) => readonly RuntimeEvent[];
  readonly capabilities: Capabilities;
  readonly shutdown: ShutdownProtocol;
  readonly sendPrompt?: (io: PromptIo, text: string) => void;
}

function pullReader(source: AsyncIterable<string>): { next: () => Promise<string | null> } {
  const it = source[Symbol.asyncIterator]();
  return {
    async next(): Promise<string | null> {
      const r = await it.next();
      return r.done ? null : r.value;
    },
  };
}

/**
 * Live event stream: raw stdout frame → JSON (falling back to the raw string
 * when it is not JSON) → `normalise` → contract events. A single live consumer
 * at a time (the frames are pulled sequentially from one transport).
 */
async function* eventStream(ctx: SessionCtx): AsyncGenerator<RuntimeEvent> {
  for (;;) {
    const line = await ctx.reader.next();
    if (line === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      raw = line;
    }
    for (const ev of ctx.normalise(raw)) {
      yield ev;
    }
  }
}

async function stopSession(ctx: SessionCtx, mode: StopMode): Promise<ClosedSession> {
  if (mode === "graceful" && ctx.shutdown.farewell) {
    try {
      ctx.handle.transport.send(ctx.shutdown.farewell.text);
    } catch {
      // best-effort farewell; force path still runs below
    }
  }
  const outcome = await ctx.handle.stop(
    mode === "graceful"
      ? { kind: "graceful", waitMs: ctx.shutdown.graceMs }
      : { kind: "immediate" },
  );
  if (outcome.kind === "stalled") {
    return { state: "closed", diagnostic: outcome.diagnostic };
  }
  return outcome.diagnostic !== undefined
    ? { state: "closed", diagnostic: outcome.diagnostic }
    : { state: "closed" };
}

function makeBusySession(ctx: SessionCtx): BusySession {
  return {
    state: "busy",
    capabilities: ctx.capabilities,
    events: () => eventStream(ctx),
    // Structural: a real interrupt protocol is per-runtime and not wired yet.
    interrupt: async () => makeIdleSession(ctx),
    stop: (opts) => stopSession(ctx, opts.mode),
  };
}

function makeIdleSession(ctx: SessionCtx): IdleSession {
  return {
    state: "idle",
    capabilities: ctx.capabilities,
    events: () => eventStream(ctx),
    async prompt(text: string): Promise<BusySession> {
      if (!ctx.sendPrompt) {
        throw new Error(`${ctx.id}: prompt/turn protocol not wired (no sendPrompt)`);
      }
      ctx.sendPrompt({ send: (l) => ctx.handle.transport.send(l) }, text);
      return makeBusySession(ctx);
    },
    stop: (opts) => stopSession(ctx, opts.mode),
  };
}

async function startSession(
  spec: SubprocessSpec,
  normalise: (raw: unknown) => readonly RuntimeEvent[],
  options: Readonly<Record<string, string>>,
): Promise<IdleSession> {
  const host = spec.host ?? nodeProcessHost();
  const plan = spec.plan ?? ((): LaunchSpec => ({ command: spec.id, args: [], env: {} }));
  const readiness: Readiness = spec.readiness ?? { kind: "process_spawned" };
  const shutdown = spec.shutdown ?? DEFAULT_SHUTDOWN;
  const capabilities = spec.capabilities ?? DEFAULT_CAPABILITIES;

  const handle = await host.spawn(plan(options));
  const reader = pullReader(handle.transport.lines());

  if (readiness.kind === "handshake_event") {
    if (!spec.handshake) {
      throw new Error(`${spec.id}: readiness handshake_event requires a handshake procedure`);
    }
    await spec.handshake({ send: (l) => handle.transport.send(l), next: () => reader.next() });
  }
  // first_event: nothing is "ready" until the first turn produces an event, so
  // the session is returned idle and the first streamed event is its witness.
  // process_spawned: the weakest — usable as soon as the child exists.

  const ctx: SessionCtx = {
    id: spec.id,
    handle,
    reader,
    normalise,
    capabilities,
    shutdown,
    ...(spec.sendPrompt ? { sendPrompt: spec.sendPrompt } : {}),
  };
  return makeIdleSession(ctx);
}

/**
 * Build a uniform `RuntimeDriver` backed by a subprocess. The kind is absorbed
 * here — the returned driver exposes only the uniform contract.
 */
export function subprocessDriver(spec: SubprocessSpec): RuntimeDriver {
  const normalise = spec.normalise ?? ((): readonly RuntimeEvent[] => []);
  const driver: RuntimeDriver = {
    id: spec.id,
    detect: spec.detect,
    models: spec.models,
    describe: spec.describe ?? emptyDeclaration,
    normalise,
    start: (options) => startSession(spec, normalise, options),
  };
  if (spec.providers) {
    driver.providers = spec.providers;
  }
  return driver;
}
