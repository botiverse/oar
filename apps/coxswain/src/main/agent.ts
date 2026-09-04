import {
  observeAgent,
  runtimes,
  simpleStateOf,
  utcInstantFromDate,
  type AgentObserver,
  type AccountUsageSnapshot,
  type AgentView,
  type AvailableInstallation,
  type Runtime,
  type Session,
  type SteerOrQueueResult,
  type Turn,
} from "@botiverse/oar";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AbortReceipt,
  AgentViewUpdate,
  ConversationEntry,
  FleetSnapshot,
  HostEvent,
  InspectResult,
  LaneSnapshot,
  LaunchRequest,
  RuntimeInspection,
  SessionEventView,
  SessionIdentity,
  SubmitReceipt,
  UsageBoundaryView,
  UsageResult,
} from "../shared/ipc.js";
import { createSayBridge, type SayBridge } from "./say-bridge.js";
import { sayProtocol } from "./say-protocol.js";
import { createVoyageRecorder, type CoxswainVoyageRecorder } from "./voyage-recorder.js";

const STALL_AFTER_MS = 15_000;
const USAGE_CLOSE_REASON = "lane closed before usage read completed";
const SMOKE_RESET = utcInstantFromDate(new Date("2026-08-23T19:39:00.000Z"));
if (SMOKE_RESET === null) {
  throw new Error("Invalid smoke usage reset fixture");
}

const SMOKE_RUNTIMES: readonly RuntimeInspection[] = [
  {
    id: "claude",
    installation: {
      kind: "available",
      via: "executable",
      command: "claude",
      version: "2.1.237",
    },
    supportsUsage: true,
  },
  {
    id: "codex",
    installation: {
      kind: "available",
      via: "executable",
      command: "codex",
      version: "0.48.0",
    },
    supportsUsage: true,
  },
  {
    id: "pi",
    installation: { kind: "available", via: "bundled" },
    supportsUsage: false,
  },
];

const SMOKE_USAGE: AccountUsageSnapshot = {
  kind: "available",
  plan: "Max",
  rateLimited: false,
  windows: [
    {
      label: "current session",
      usedRatio: 0.07,
      resetsAt: SMOKE_RESET,
    },
    { label: "week · all models", usedRatio: 0.32 },
  ],
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown host error";
}

async function resolveWorkingDirectory(input: string): Promise<string> {
  const expanded = input === "~"
    ? homedir()
    : input.startsWith("~/")
      ? join(homedir(), input.slice(2))
      : input;
  const absolute = resolve(expanded);
  const metadata = await stat(absolute);
  if (!metadata.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${absolute}`);
  }
  return absolute;
}

export interface AgentHostOptions {
  readonly smoke?: boolean;
  /** Where per-lane JSONL voyage files are written. */
  readonly voyageDirectory?: string;
  /** Clock injection for deterministic host/recorder tests. */
  readonly now?: () => number;
  /** Runtime registry seam used by deterministic host tests; defaults to OAR's built-ins. */
  readonly runtimeRegistry?: RuntimeCatalog;
}

export interface RuntimeCatalog {
  get(id: string): Runtime | undefined;
  list(): readonly Runtime[];
  require(id: string): Runtime;
}

interface Lane {
  readonly id: string;
  readonly order: number;
  readonly identity: SessionIdentity;
  readonly session: Session;
  readonly sayBridge: SayBridge;
  readonly recorder: CoxswainVoyageRecorder;
  readonly listeners: Set<(event: HostEvent) => void>;
  readonly agentObserver: AgentObserver;
  readonly closeStarted: Promise<void>;
  readonly signalClose: () => void;
  unsubscribeEvents: () => void;
  unsubscribeAgent: () => void;
  closePromise: Promise<void> | null;
  submitTail: Promise<void>;
  /** Usage boundary probes are serialized with turn finalization. */
  usageTail: Promise<void>;
  readonly usageBefore: Map<string, UsageBoundaryView>;
  readonly usageAfter: Set<string>;
  pendingPromptUsageBefore: UsageBoundaryView | null;
  turn: Turn | null;
  protocolSent: boolean;
  view: AgentViewUpdate;
  closing: boolean;
}

type LaneHostEvent =
  | { readonly kind: "activity"; readonly event: SessionEventView }
  | { readonly kind: "agent_view"; readonly view: AgentViewUpdate }
  | { readonly kind: "conversation"; readonly entry: ConversationEntry }
  | { readonly kind: "usage"; readonly boundary: UsageBoundaryView }
  | { readonly kind: "host_error"; readonly message: string };

const initialAgentView = (): AgentViewUpdate => ({
  status: { kind: "idle" },
  stall: null,
  simple: "idle",
});

/**
 * Main-process owner for one or more independent OAR sessions. A lane is the
 * unit of identity, lifecycle, event fan-out, and voyage recording. The
 * text-only launch/submit/abort methods retain the original one-lane API by
 * targeting the most recently launched lane.
 */
export class AgentHost {
  readonly #smoke: boolean;
  readonly #voyageDirectory: string;
  readonly #now: () => number;
  readonly #runtimeRegistry: RuntimeCatalog;
  readonly #listeners = new Set<(event: HostEvent) => void>();
  readonly #installations = new Map<string, AvailableInstallation>();
  readonly #lanes = new Map<string, Lane>();
  readonly #laneReservations = new Set<string>();
  readonly #laneOrders = new Map<string, number>();
  #laneCounter = 1;
  #laneOrderCounter = 1;
  #activeLaneId: string | null = null;
  #disposed = false;

  constructor(options: AgentHostOptions = {}) {
    this.#smoke = options.smoke ?? false;
    this.#voyageDirectory = options.voyageDirectory
      ?? process.env.COXSWAIN_VOYAGE_DIR
      ?? join(process.cwd(), ".coxswain", "voyages");
    this.#now = options.now ?? ((): number => Date.now());
    this.#runtimeRegistry = options.runtimeRegistry ?? runtimes;
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Subscribe to only one lane while preserving the lane-tagged event shape. */
  subscribeLane(laneId: string, listener: (event: HostEvent) => void): () => void {
    const lane = this.#lanes.get(laneId);
    if (lane === undefined) {
      throw new Error(`unknown lane: ${laneId}`);
    }
    lane.listeners.add(listener);
    return () => {
      lane.listeners.delete(listener);
    };
  }

  #emit(event: HostEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Host observers are side taps; one renderer listener cannot starve another.
      }
    }
    if (event.laneId === undefined) {
      return;
    }
    const lane = this.#lanes.get(event.laneId);
    if (lane === undefined) {
      return;
    }
    for (const listener of lane.listeners) {
      try {
        listener(event);
      } catch {
        // Per-lane observer isolation mirrors OAR's Session observer contract.
      }
    }
  }

  #emitLane(laneId: string, event: LaneHostEvent): void {
    this.#emit({ ...event, laneId });
  }

  async #probeRuntime(runtime: Runtime): Promise<RuntimeInspection> {
    if (runtime.installation === undefined) {
      return {
        id: runtime.id,
        installation: { kind: "unsupported", reason: "installation probe unavailable" },
        supportsUsage: runtime.accountUsage !== undefined,
      };
    }
    try {
      const installation = await runtime.installation();
      if (installation.kind === "available") {
        this.#installations.set(runtime.id, installation);
      }
      return {
        id: runtime.id,
        installation,
        supportsUsage: runtime.accountUsage !== undefined,
      };
    } catch (error) {
      return {
        id: runtime.id,
        installation: { kind: "error", reason: messageOf(error) },
        supportsUsage: runtime.accountUsage !== undefined,
      };
    }
  }

  async inspect(): Promise<InspectResult> {
    if (this.#smoke) {
      return { defaultCwd: "~/play/oar-demo", runtimes: SMOKE_RUNTIMES };
    }
    const inspected = await Promise.all(this.#runtimeRegistry.list().map(async (runtime) =>
      this.#probeRuntime(runtime)));
    return { defaultCwd: process.cwd(), runtimes: inspected };
  }

  async #availableInstallation(runtime: Runtime): Promise<AvailableInstallation | null> {
    const cached = this.#installations.get(runtime.id);
    if (cached !== undefined) {
      return cached;
    }
    if (runtime.installation === undefined) {
      return null;
    }
    const installation = await runtime.installation();
    if (installation.kind !== "available") {
      return null;
    }
    this.#installations.set(runtime.id, installation);
    return installation;
  }

  async readUsage(runtimeId: string): Promise<UsageResult> {
    if (this.#smoke) {
      return runtimeId === "claude"
        ? { kind: "loaded", usage: SMOKE_USAGE }
        : { kind: "loaded", usage: { kind: "unsupported" } };
    }
    const runtime = this.#runtimeRegistry.get(runtimeId);
    if (runtime === undefined) {
      return { kind: "error", reason: `unknown runtime: ${runtimeId}` };
    }
    if (runtime.accountUsage === undefined) {
      return { kind: "loaded", usage: { kind: "unsupported" } };
    }
    try {
      const installation = await this.#availableInstallation(runtime);
      if (installation === null) {
        return { kind: "unavailable", reason: `${runtimeId} is not available` };
      }
      return { kind: "loaded", usage: await runtime.accountUsage(installation) };
    } catch (error) {
      return { kind: "error", reason: messageOf(error) };
    }
  }

  async #usageBoundary(
    lane: Lane,
    turnId: string,
    phase: UsageBoundaryView["phase"],
  ): Promise<UsageBoundaryView> {
    const result = await this.readUsage(lane.identity.runtimeId).catch((error: unknown): UsageResult => ({
      // Keep the boundary observable even if an unexpected adapter error
      // escapes readUsage; a missing sample would look like a stuck helm.
      kind: "error",
      reason: messageOf(error),
    }));
    return { turnId, phase, sampledAt: this.#now(), result };
  }

  #usageCloseBoundary(
    turnId: string,
    phase: UsageBoundaryView["phase"],
  ): UsageBoundaryView {
    return {
      turnId,
      phase,
      sampledAt: this.#now(),
      result: { kind: "error", reason: USAGE_CLOSE_REASON },
    };
  }

  #laneIsClosing(lane: Lane): boolean {
    return lane.closing;
  }

  async #usageBoundaryOrClose(
    lane: Lane,
    turnId: string,
    phase: UsageBoundaryView["phase"],
  ): Promise<UsageBoundaryView> {
    if (this.#laneIsClosing(lane)) {
      return this.#usageCloseBoundary(turnId, phase);
    }
    const probe = this.#usageBoundary(lane, turnId, phase);
    const close = lane.closeStarted.then(() => this.#usageCloseBoundary(turnId, phase));
    return Promise.race([probe, close]);
  }

  /** Queue a usage read behind any earlier boundary on this lane. */
  async #usageBoundaryInOrder(
    lane: Lane,
    turnId: string,
    phase: UsageBoundaryView["phase"],
  ): Promise<UsageBoundaryView> {
    const operation = lane.usageTail.then(async () => this.#usageBoundaryOrClose(lane, turnId, phase));
    // Keep the lane chain alive after an unexpected implementation failure;
    // the boundary itself normally resolves with an explicit error result.
    lane.usageTail = operation.then(() => {}, () => {});
    return operation;
  }

  #emitUsageBoundary(lane: Lane, boundary: UsageBoundaryView): void {
    this.#emitLane(lane.id, { kind: "usage", boundary });
  }

  #queueUsageAfter(lane: Lane, event: Extract<SessionEventView, { readonly kind: "turn_ended" }>): void {
    if (lane.usageAfter.has(event.turnId)) {
      return;
    }
    lane.usageAfter.add(event.turnId);
    const operation = this.#usageBoundaryInOrder(lane, event.turnId, "after").then((boundary) => {
      this.#emitUsageBoundary(lane, boundary);
      lane.usageBefore.delete(event.turnId);
    });
    lane.usageTail = operation.catch((error: unknown) => {
      this.#emitLane(lane.id, { kind: "host_error", message: messageOf(error) });
    });
  }

  #queueSpontaneousUsageBefore(lane: Lane, turnId: string): void {
    if (lane.usageBefore.has(turnId) || lane.usageAfter.has(turnId)) {
      return;
    }
    lane.usageBefore.set(turnId, {
      // The placeholder prevents duplicate probes while the serialized read
      // is pending. It is never emitted; the concrete boundary replaces it.
      turnId,
      phase: "before",
      sampledAt: 0,
      result: { kind: "error", reason: "usage read pending" },
    });
    const operation = this.#usageBoundaryInOrder(lane, turnId, "before");
    lane.usageTail = operation.then((boundary) => {
      lane.usageBefore.set(turnId, boundary);
      this.#emitUsageBoundary(lane, boundary);
    }).catch((error: unknown) => {
      this.#emitLane(lane.id, { kind: "host_error", message: messageOf(error) });
    });
  }

  async #promptUsageBefore(lane: Lane): Promise<UsageBoundaryView> {
    // A prompt does not reveal its turn id until it returns. Keep this sample
    // private until #submitLane can attach the real id, while still making the
    // accountUsage read happen before the runtime sees the prompt.
    return this.#usageBoundaryInOrder(lane, "pending", "before");
  }

  #reserveLaneId(requested: string | undefined): string {
    const trimmed = requested?.trim() ?? "";
    if (trimmed.length > 0) {
      if (this.#lanes.has(trimmed) || this.#laneReservations.has(trimmed)) {
        throw new Error(`lane already exists: ${trimmed}`);
      }
      this.#laneReservations.add(trimmed);
      this.#laneOrders.set(trimmed, this.#laneOrderCounter);
      this.#laneOrderCounter += 1;
      return trimmed;
    }
    let generated = "";
    do {
      generated = `lane-${this.#laneCounter}`;
      this.#laneCounter += 1;
    } while (this.#lanes.has(generated) || this.#laneReservations.has(generated));
    this.#laneReservations.add(generated);
    this.#laneOrders.set(generated, this.#laneOrderCounter);
    this.#laneOrderCounter += 1;
    return generated;
  }

  #releaseLaneReservation(laneId: string): void {
    this.#laneReservations.delete(laneId);
    if (!this.#lanes.has(laneId)) {
      this.#laneOrders.delete(laneId);
    }
  }

  #reserveFleetLaneIds(requests: readonly LaunchRequest[]): string[] {
    const reservations: string[] = [];
    try {
      for (const request of requests) {
        const laneId = this.#reserveLaneId(request.laneId);
        reservations.push(laneId);
      }
      return reservations;
    } catch (error) {
      for (const laneId of reservations) {
        this.#releaseLaneReservation(laneId);
      }
      throw error;
    }
  }

  #wireInput(lane: Lane, input: string): string {
    if (lane.protocolSent) {
      return input;
    }
    return `${sayProtocol()}\n\nHuman message:\n${input}`;
  }

  #emitHuman(lane: Lane, text: string, delivery: "prompted" | "steered" | "queued"): void {
    this.#emitLane(lane.id, {
      kind: "conversation",
      entry: {
        kind: "human",
        id: randomUUID(),
        text,
        receivedAt: this.#now(),
        delivery,
      },
    });
  }

  #watchTurn(lane: Lane, turn: Turn): void {
    lane.turn = turn;
    void turn.outcome.then(() => {
      if (lane.turn === turn) {
        lane.turn = null;
      }
    }).catch((error: unknown) => {
      if (lane.turn === turn) {
        lane.turn = null;
      }
      this.#emitLane(lane.id, { kind: "host_error", message: messageOf(error) });
    });
  }

  async #launchReserved(request: LaunchRequest, laneId: string): Promise<SessionIdentity> {
    const runtime = this.#runtimeRegistry.require(request.runtimeId);
    const installation = await this.#availableInstallation(runtime);
    if (installation === null) {
      throw new Error(`${request.runtimeId} is not available`);
    }
    const cwd = await resolveWorkingDirectory(request.cwd);
    let sayBridge: SayBridge | null = null;
    let session: Session | null = null;
    let recorder: CoxswainVoyageRecorder | null = null;
    try {
      sayBridge = await createSayBridge((text) => {
        this.#emitLane(laneId, {
          kind: "conversation",
          entry: { kind: "agent", id: randomUUID(), text, receivedAt: this.#now() },
        });
      });
      session = await runtime.session(installation, {
        cwd,
        env: sayBridge.env,
        ...(request.model === undefined ? {} : { model: request.model }),
      });
      recorder = await createVoyageRecorder({
        laneId,
        sessionId: session.id,
        runtimeId: runtime.id,
        cwd,
        ...(request.model === undefined ? {} : { model: request.model }),
        directory: this.#voyageDirectory,
        now: this.#now,
        onError: (error) => {
          this.#emitLane(laneId, { kind: "host_error", message: messageOf(error) });
        },
      });
      if (this.#disposed) {
        throw new Error("The coxswain host is disposed");
      }
    } catch (error) {
      if (session !== null) {
        await session.dispose().catch(() => {});
      }
      if (recorder !== null) {
        recorder.close("launch failed");
      }
      if (sayBridge !== null) {
        await sayBridge.dispose().catch(() => {});
      }
      throw error;
    }
    const identity: SessionIdentity = {
      laneId,
      runtimeId: runtime.id,
      sessionId: session.id,
      cwd,
      ...(request.model === undefined ? {} : { model: request.model }),
      voyagePath: recorder.path,
    };
    let unsubscribeEvents: (() => void) | null = null;
    let agentObserver: AgentObserver | null = null;
    let registeredLane: Lane | null = null;
    try {
      unsubscribeEvents = session.subscribe((event) => {
        // Record the exact public event before deriving any host/UI projection.
        recorder.recordEvent(event);
        this.#emitLane(laneId, { kind: "activity", event });
        const currentLane = this.#lanes.get(laneId);
        if (event.kind === "turn_started"
          && currentLane !== undefined
          && currentLane.pendingPromptUsageBefore === null
          && currentLane.turn === null) {
          // Some runtimes autonomously start a queued turn after the previous
          // one ends. There is no prompt call to own its baseline, so probe it
          // from the public event boundary instead.
          this.#queueSpontaneousUsageBefore(currentLane, event.turnId);
        }
        if (event.kind === "turn_ended") {
          this.#emitLane(laneId, {
            kind: "conversation",
            entry: {
              kind: "outcome",
              id: randomUUID(),
              turnId: event.turnId,
              receivedAt: event.receivedAt,
              outcome: event.outcome,
            },
          });
          if (currentLane?.turn?.id === event.turnId) {
            currentLane.turn = null;
          }
          if (currentLane !== undefined) {
            // Reserve this operation immediately, before a runtime can drain
            // a queued turn from inside its turn_ended notification. The read
            // itself resumes in a microtask, after prompt() has attached a
            // synchronously-emitted turn's baseline.
            this.#queueUsageAfter(currentLane, event);
          }
        }
      });
      agentObserver = observeAgent(session, { now: this.#now, stallAfterMs: STALL_AFTER_MS });
      const closeSignal = Promise.withResolvers<void>();
      const lane: Lane = {
        id: laneId,
        order: this.#laneOrders.get(laneId) ?? this.#laneOrderCounter,
        identity,
        session,
        sayBridge,
        recorder,
        listeners: new Set(),
        agentObserver,
        closeStarted: closeSignal.promise,
        signalClose: (): void => {
          closeSignal.resolve();
        },
        // Assigned below immediately after the object exists; these callbacks
        // never run before subscribe is called.
        unsubscribeEvents,
        unsubscribeAgent: (): void => {},
        closePromise: null,
        submitTail: Promise.resolve(),
        usageTail: Promise.resolve(),
        usageBefore: new Map(),
        usageAfter: new Set(),
        pendingPromptUsageBefore: null,
        turn: null,
        protocolSent: false,
        view: initialAgentView(),
        closing: false,
      };
      this.#lanes.set(laneId, lane);
      registeredLane = lane;
      this.#releaseLaneReservation(laneId);
      const unsubscribeAgent = agentObserver.subscribe((view: AgentView) => {
        const currentLane = this.#lanes.get(laneId);
        if (currentLane === undefined) {
          return;
        }
        currentLane.view = { status: view.status, stall: view.stall, simple: simpleStateOf(view) };
        this.#emitLane(laneId, { kind: "agent_view", view: currentLane.view });
      });
      lane.unsubscribeAgent = unsubscribeAgent;
      const activeLane = this.#activeLaneId === null
        ? null
        : this.#lanes.get(this.#activeLaneId);
      // Launch completion can race in a fleet. Choose the greatest reserved
      // order so the compatibility (lane-omitted) API is deterministic.
      if (activeLane === undefined || activeLane === null || activeLane.order <= lane.order) {
        this.#activeLaneId = laneId;
      }
      return identity;
    } catch (error) {
      if (registeredLane !== null) {
        this.#lanes.delete(laneId);
      }
      unsubscribeEvents?.();
      agentObserver?.dispose();
      await session.dispose().catch(() => {});
      recorder.close("launch failed");
      await sayBridge.dispose().catch(() => {});
      throw error;
    }
  }

  async launch(request: LaunchRequest): Promise<SessionIdentity> {
    if (this.#disposed) {
      throw new Error("The coxswain host is disposed");
    }
    const laneId = this.#reserveLaneId(request.laneId);
    try {
      return await this.#launchReserved(request, laneId);
    } catch (error) {
      this.#releaseLaneReservation(laneId);
      throw error;
    }
  }

  async launchFleet(
    requests: { readonly lanes: readonly LaunchRequest[] },
  ): Promise<readonly SessionIdentity[]> {
    if (this.#disposed) {
      throw new Error("The coxswain host is disposed");
    }
    const lanes = requests.lanes;
    if (lanes.length === 0) {
      throw new Error("fleet must contain at least one lane");
    }
    const reservations = this.#reserveFleetLaneIds(lanes);
    const launched = await Promise.allSettled(
      lanes.map(async (request, index) => this.#launchReserved(request, reservations[index] ?? "")),
    );
    const identities: SessionIdentity[] = [];
    let failure: unknown = null;
    for (const [index, result] of launched.entries()) {
      const laneId = reservations[index];
      if (laneId !== undefined) {
        if (result.status === "fulfilled") {
          identities.push(result.value);
        } else {
          this.#releaseLaneReservation(laneId);
          failure ??= result.reason;
        }
      }
    }
    if (failure !== null) {
      await Promise.all(identities.map(async (identity) => this.closeLane(identity.laneId)));
      throw new Error(messageOf(failure));
    }
    return identities;
  }

  fleet(): FleetSnapshot {
    const lanes: LaneSnapshot[] = [...this.#lanes.values()]
      .toSorted((left, right) => left.order - right.order)
      .map((lane) => {
      const snapshot: LaneSnapshot = { identity: lane.identity, view: lane.view };
      if (lane.turn !== null) {
        Object.assign(snapshot, { activeTurnId: lane.turn.id });
      }
      return snapshot;
      });
    return { lanes };
  }

  #laneOrActive(laneId?: string): Lane | null {
    const target = laneId ?? this.#activeLaneId;
    if (target === null) {
      return null;
    }
    return this.#lanes.get(target) ?? null;
  }

  async #submitLane(lane: Lane, text: string): Promise<SubmitReceipt> {
    if (this.#laneIsClosing(lane)) {
      return { landed: "rejected", reason: "The agent lane is closing" };
    }
    const wireInput = this.#wireInput(lane, text);
    const ticket = lane.recorder.beginSubmission({
      text,
      viaHint: lane.turn === null ? "prompt" : "steer",
    });
    const activeTurn = lane.turn;
    if (activeTurn !== null) {
      try {
        // Always attach a rejection handler to the runtime operation. A close
        // may win the race while the runtime is still unwinding; the late
        // rejection must be consumed rather than becoming an unhandled one.
        const steerOperation = async (): Promise<SteerOrQueueResult> =>
          lane.session.steerOrQueue(activeTurn, wireInput);
        const steerResult = steerOperation().then(
          (result) => ({ kind: "receipt" as const, result }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );
        const receipt = await Promise.race([
          steerResult,
          lane.closeStarted.then(() => ({ kind: "closing" as const })),
        ]);
        if (receipt.kind === "closing") {
          ticket.complete({ via: "steer" });
          return { landed: "rejected", reason: "The agent lane is closing" };
        }
        if (receipt.kind === "error") {
          throw receipt.error;
        }
        const { result } = receipt;
        if (result.landed === "rejected") {
          ticket.complete({ via: "steer" });
          return result;
        }
        lane.protocolSent = true;
        ticket.complete({ via: result.landed === "steered" ? "steer" : "queue" });
        this.#emitHuman(lane, text, result.landed);
        return { landed: result.landed, turnId: activeTurn.id };
      } catch (error) {
        const reason = messageOf(error);
        ticket.complete({ via: "steer" });
        this.#emitLane(lane.id, { kind: "host_error", message: reason });
        return { landed: "rejected", reason };
      }
    }

    // Mark the prompt boundary before awaiting the read. This prevents a
    // simultaneous public turn_started notification from being misclassified
    // as an autonomous turn while the baseline probe is in flight.
    lane.pendingPromptUsageBefore = {
      turnId: "pending",
      phase: "before",
      sampledAt: 0,
      result: { kind: "error", reason: "usage read pending" },
    };
    const beforeBoundary = await this.#promptUsageBefore(lane).catch((error: unknown): UsageBoundaryView => ({
      // Usage is an observability side-channel. An unexpected probe failure
      // must not prevent a prompt from being delivered; expose it as a normal
      // usage error boundary when possible and continue the turn.
      turnId: "pending",
      phase: "before",
      sampledAt: this.#now(),
      result: { kind: "error", reason: messageOf(error) },
    }));
    lane.pendingPromptUsageBefore = beforeBoundary;
    if (lane.closing) {
      lane.pendingPromptUsageBefore = null;
      ticket.complete({ via: "prompt" });
      return { landed: "rejected", reason: "The agent lane is closing" };
    }
    try {
      const result = lane.session.prompt(wireInput);
      if (result.kind === "busy") {
        lane.pendingPromptUsageBefore = null;
        const reason = "The runtime is busy without a controllable turn handle";
        ticket.complete({ via: "prompt" });
        return { landed: "rejected", reason };
      }
      const attachedBefore: UsageBoundaryView = {
        ...beforeBoundary,
        turnId: result.turn.id,
      };
      lane.usageBefore.set(result.turn.id, attachedBefore);
      this.#emitUsageBoundary(lane, attachedBefore);
      lane.protocolSent = true;
      this.#watchTurn(lane, result.turn);
      lane.pendingPromptUsageBefore = null;
      ticket.complete({ via: "prompt" });
      this.#emitHuman(lane, text, "prompted");
      return { landed: "prompted", turnId: result.turn.id };
    } catch (error) {
      lane.pendingPromptUsageBefore = null;
      const reason = messageOf(error);
      ticket.complete({ via: "prompt" });
      this.#emitLane(lane.id, { kind: "host_error", message: reason });
      return { landed: "rejected", reason };
    }
  }

  async submit(text: string, laneId?: string): Promise<SubmitReceipt> {
    const lane = this.#laneOrActive(laneId);
    if (lane === null) {
      return { landed: "rejected", reason: "No agent session is running" };
    }
    // Session has one active turn, and the recorder's ordering barrier is per
    // submission. Serialize callers on a lane so concurrent renderer invokes
    // cannot make two asynchronous steer/queue operations share one barrier.
    const operation = lane.submitTail.then(async () => this.#submitLane(lane, text));
    lane.submitTail = operation.then(() => {}, () => {});
    return operation;
  }

  async submitToLane(laneId: string, text: string): Promise<SubmitReceipt> {
    return this.submit(text, laneId);
  }

  async abort(laneId?: string): Promise<AbortReceipt> {
    const lane = this.#laneOrActive(laneId);
    const turn = lane?.turn;
    if (turn === null || turn === undefined) {
      return { aborted: false };
    }
    await turn.abort();
    return { aborted: true };
  }

  async closeLane(laneId: string): Promise<void> {
    const lane = this.#lanes.get(laneId);
    if (lane === undefined) {
      return;
    }
    if (lane.closePromise !== null) {
      await lane.closePromise;
      return;
    }
    lane.closing = true;
    lane.signalClose();
    lane.closePromise = this.#closeLaneImpl(lane);
    await lane.closePromise;
  }

  async #closeLaneImpl(lane: Lane): Promise<void> {
    try {
      // Keep the event subscription live while dispose emits its terminal
      // event, then tear down observers and the bridge.
      await lane.session.dispose();
    } catch (error) {
      this.#emitLane(lane.id, { kind: "host_error", message: messageOf(error) });
    } finally {
      // Disposal aborts an active turn and releases any steer/queue wait. Let
      // the in-flight renderer submission and usage probes finish before
      // writing the final end marker. Usage boundaries are emitted before the
      // lane is removed so a renderer cannot miss the matching after sample.
      await lane.submitTail;
      await lane.usageTail;
      lane.unsubscribeAgent();
      lane.agentObserver.dispose();
      lane.unsubscribeEvents();
      await lane.sayBridge.dispose().catch((error: unknown) => {
        this.#emitLane(lane.id, { kind: "host_error", message: messageOf(error) });
      });
      lane.recorder.close("lane closed");
      lane.listeners.clear();
      this.#lanes.delete(lane.id);
      this.#laneOrders.delete(lane.id);
      if (this.#activeLaneId === lane.id) {
        this.#activeLaneId = [...this.#lanes.values()]
          .toSorted((left, right) => left.order - right.order)
          .at(-1)?.id ?? null;
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await Promise.all([...this.#lanes.keys()].map(async (laneId) => this.closeLane(laneId)));
    this.#listeners.clear();
    this.#laneReservations.clear();
    this.#activeLaneId = null;
  }
}
