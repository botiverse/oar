import type {
  AccountUsageSnapshot,
  AccountUsageWindow,
  AgentStatus,
  AgentView,
  InstallationSnapshot,
  RunningPhase,
  SessionEvent,
  SessionEventBody,
  TurnOutcome,
  UtcInstant,
} from "@botiverse/oar";

export const IPC_CHANNELS = {
  abort: "coxswain:abort",
  closeLane: "coxswain:close-lane",
  event: "coxswain:event",
  fleet: "coxswain:fleet",
  inspect: "coxswain:inspect",
  launch: "coxswain:launch",
  launchFleet: "coxswain:launch-fleet",
  rendererReady: "coxswain:renderer-ready",
  submit: "coxswain:submit",
  usage: "coxswain:usage",
} as const;

export type FailureClass = Extract<TurnOutcome, { readonly kind: "failed" }>["failure"];
export type TurnOutcomeView = TurnOutcome;

export type InstallationView = InstallationSnapshot
  | { readonly kind: "error"; readonly reason: string };

export interface RuntimeInspection {
  readonly id: string;
  readonly installation: InstallationView;
  readonly supportsUsage: boolean;
}

export interface InspectResult {
  readonly defaultCwd: string;
  readonly runtimes: readonly RuntimeInspection[];
}

export type UsageWindowView = AccountUsageWindow;
export type UsageSnapshotView = AccountUsageSnapshot;

export type UsageResult =
  | { readonly kind: "loaded"; readonly usage: UsageSnapshotView }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string };

/** One accountUsage observation associated with a turn boundary. */
export interface UsageBoundaryView {
  readonly turnId: string;
  readonly phase: "before" | "after";
  /** Local epoch milliseconds when the read completed. */
  readonly sampledAt: number;
  readonly result: UsageResult;
}

export interface LaunchRequest {
  readonly runtimeId: string;
  readonly cwd: string;
  /** Optional caller-selected lane id; omitted ids are allocated by the host. */
  readonly laneId?: string;
  readonly model?: string;
}

export interface SessionIdentity {
  /** Stable Coxswain lane identity (always present on host responses). */
  readonly laneId: string;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: string;
  /** Absolute path to the append-only voyage log for this lane. */
  readonly voyagePath?: string;
}

export interface LaneSnapshot {
  readonly identity: SessionIdentity;
  readonly activeTurnId?: string;
  readonly view: AgentViewUpdate;
}

export interface FleetSnapshot {
  readonly lanes: readonly LaneSnapshot[];
}

export interface LaunchFleetRequest {
  readonly lanes: readonly LaunchRequest[];
}

export interface LaneRequest {
  readonly laneId: string;
}

export interface SubmitRequest {
  readonly text: string;
  /** Omitted for backwards compatibility; targets the host's active lane. */
  readonly laneId?: string;
}

export type SubmitReceipt =
  | {
      readonly landed: "prompted" | "steered" | "queued";
      readonly turnId: string;
    }
  | { readonly landed: "rejected"; readonly reason: string };

export interface AbortReceipt {
  readonly aborted: boolean;
}

export type RunningPhaseView = RunningPhase;
export type AgentStatusView = AgentStatus;

export type AgentViewUpdate = AgentView & {
  readonly simple: "idle" | "busy" | "stuck" | "error";
};

export type SessionEventBodyView = SessionEventBody;
export type SessionEventView = SessionEvent;

export type ConversationEntry =
  | {
      readonly kind: "human";
      readonly id: string;
      readonly text: string;
      readonly receivedAt: number;
      readonly delivery: "prompted" | "steered" | "queued";
    }
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly text: string;
      readonly receivedAt: number;
    }
  | {
      readonly kind: "outcome";
      readonly id: string;
      readonly turnId: string;
      readonly receivedAt: number;
      readonly outcome: TurnOutcomeView;
    };

export type HostEvent =
  | { readonly kind: "activity"; readonly laneId: string; readonly event: SessionEventView }
  | { readonly kind: "agent_view"; readonly laneId: string; readonly view: AgentViewUpdate }
  | { readonly kind: "conversation"; readonly laneId: string; readonly entry: ConversationEntry }
  | { readonly kind: "usage"; readonly laneId: string; readonly boundary: UsageBoundaryView }
  | { readonly kind: "host_error"; readonly laneId?: string; readonly message: string };

export interface CoxswainApi {
  inspect(): Promise<InspectResult>;
  readUsage(runtimeId: string): Promise<UsageResult>;
  launch(request: LaunchRequest): Promise<SessionIdentity>;
  launchFleet(request: LaunchFleetRequest): Promise<readonly SessionIdentity[]>;
  fleet(): Promise<FleetSnapshot>;
  submit(request: SubmitRequest): Promise<SubmitReceipt>;
  abort(request?: LaneRequest): Promise<AbortReceipt>;
  closeLane(request: LaneRequest): Promise<void>;
  rendererReady(): Promise<void>;
  onHostEvent(listener: (event: HostEvent) => void): () => void;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

export function parseRuntimeId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("runtimeId must be a non-empty string");
  }
  return value.trim();
}

export function parseLaunchRequest(value: unknown): LaunchRequest {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("launch request must be an object");
  }
  const runtimeId = requiredString(record, "runtimeId");
  const cwd = requiredString(record, "cwd");
  const laneValue = record.laneId;
  if (laneValue !== undefined && typeof laneValue !== "string") {
    throw new Error("laneId must be a string when provided");
  }
  const laneId = typeof laneValue === "string" ? laneValue.trim() : "";
  const modelValue = record.model;
  if (modelValue !== undefined && typeof modelValue !== "string") {
    throw new Error("model must be a string when provided");
  }
  const model = typeof modelValue === "string" ? modelValue.trim() : "";
  return {
    runtimeId,
    cwd,
    ...(laneId.length === 0 ? {} : { laneId }),
    ...(model.length === 0 ? {} : { model }),
  };
}

export function parseLaunchFleetRequest(value: unknown): LaunchFleetRequest {
  const record = recordOf(value);
  if (record === null || !Array.isArray(record.lanes) || record.lanes.length === 0) {
    throw new Error("launch fleet request must contain lanes");
  }
  return { lanes: record.lanes.map(parseLaunchRequest) };
}

export function parseSubmitRequest(value: unknown): SubmitRequest {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("submit request must be an object");
  }
  const laneValue = record.laneId;
  if (laneValue !== undefined && typeof laneValue !== "string") {
    throw new Error("laneId must be a string when provided");
  }
  const laneId = typeof laneValue === "string" ? laneValue.trim() : "";
  return laneId.length === 0
    ? { text: requiredString(record, "text") }
    : { text: requiredString(record, "text"), laneId };
}

export function parseLaneRequest(value: unknown): LaneRequest {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("lane request must be an object");
  }
  return { laneId: requiredString(record, "laneId") };
}

function requiredBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new TypeError(`${key} must be a boolean`);
  }
  return value;
}

export function parseCanonicalUtcInstant(value: string): UtcInstant | null;
export function parseCanonicalUtcInstant(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const canonical = date.toISOString();
  return canonical === value ? canonical : null;
}

function parseInstallation(value: unknown): InstallationView {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("installation must be an object");
  }
  switch (record.kind) {
    case "available": {
      if (record.via === "bundled") {
        return { kind: "available", via: "bundled" };
      }
      if (record.via !== "executable") {
        throw new Error("available installation must declare its source");
      }
      const command = requiredString(record, "command");
      const version = record.version;
      if (version !== undefined && typeof version !== "string") {
        throw new Error("installation version must be a string");
      }
      return version === undefined
        ? { kind: "available", via: "executable", command }
        : { kind: "available", via: "executable", command, version };
    }
    case "not_found":
      return { kind: "not_found" };
    case "unsupported":
      return { kind: "unsupported", reason: requiredString(record, "reason") };
    case "error":
      return { kind: "error", reason: requiredString(record, "reason") };
    default:
      throw new Error("unknown installation kind");
  }
}

function parseRuntimeInspection(value: unknown): RuntimeInspection {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("runtime inspection must be an object");
  }
  return {
    id: requiredString(record, "id"),
    installation: parseInstallation(record.installation),
    supportsUsage: requiredBoolean(record, "supportsUsage"),
  };
}

export function parseInspectResult(value: unknown): InspectResult {
  const record = recordOf(value);
  if (record === null || !Array.isArray(record.runtimes)) {
    throw new Error("inspect result must contain runtimes");
  }
  return {
    defaultCwd: requiredString(record, "defaultCwd"),
    runtimes: record.runtimes.map(parseRuntimeInspection),
  };
}

function parseUsageWindow(value: unknown): UsageWindowView {
  const record = recordOf(value);
  if (record === null
    || typeof record.usedRatio !== "number"
    || !Number.isFinite(record.usedRatio)
    || record.usedRatio < 0
    || record.usedRatio > 1) {
    throw new Error("usage window must contain a numeric ratio");
  }
  const label = requiredString(record, "label");
  const resetsAt = record.resetsAt;
  if (resetsAt !== undefined && typeof resetsAt !== "string") {
    throw new Error("usage reset must be a string");
  }
  const parsedReset = typeof resetsAt === "string"
    ? parseCanonicalUtcInstant(resetsAt)
    : undefined;
  if (parsedReset === null) {
    throw new Error("usage reset must be a canonical UTC instant");
  }
  return parsedReset === undefined
    ? { label, usedRatio: record.usedRatio }
    : { label, usedRatio: record.usedRatio, resetsAt: parsedReset };
}

function parseUsageSnapshot(value: unknown): UsageSnapshotView {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("usage snapshot must be an object");
  }
  switch (record.kind) {
    case "reauth_required":
      return { kind: "reauth_required" };
    case "unsupported":
      return { kind: "unsupported" };
    case "available": {
      if (!Array.isArray(record.windows)) {
        throw new TypeError("available usage must contain windows");
      }
      const plan = record.plan;
      if (plan !== undefined && typeof plan !== "string") {
        throw new Error("usage plan must be a string");
      }
      const email = record.email;
      if (email !== undefined && typeof email !== "string") {
        throw new Error("usage email must be a string");
      }
      const base = {
        kind: "available" as const,
        ...(plan === undefined ? {} : { plan }),
        ...(email === undefined ? {} : { email }),
        rateLimited: requiredBoolean(record, "rateLimited"),
        windows: record.windows.map(parseUsageWindow),
      };
      return base;
    }
    default:
      throw new Error("unknown usage kind");
  }
}

export function parseUsageResult(value: unknown): UsageResult {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("usage result must be an object");
  }
  switch (record.kind) {
    case "loaded":
      return { kind: "loaded", usage: parseUsageSnapshot(record.usage) };
    case "unavailable":
      return { kind: "unavailable", reason: requiredString(record, "reason") };
    case "error":
      return { kind: "error", reason: requiredString(record, "reason") };
    default:
      throw new Error("unknown usage result kind");
  }
}

/** Parse the usage-bearing host event at the isolated renderer boundary. */
export function parseUsageHostEvent(
  value: unknown,
): Extract<HostEvent, { readonly kind: "usage" }> {
  const record = recordOf(value);
  if (record === null || record.kind !== "usage") {
    throw new Error("usage host event must be an object");
  }
  return {
    kind: "usage",
    laneId: requiredString(record, "laneId"),
    boundary: parseUsageBoundary(record.boundary),
  };
}

/** Validate the usage boundary envelope crossing the isolated renderer IPC. */
export function parseUsageBoundary(value: unknown): UsageBoundaryView {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("usage boundary must be an object");
  }
  const turnId = requiredString(record, "turnId");
  const phase = record.phase;
  if (phase !== "before" && phase !== "after") {
    throw new Error("usage boundary phase must be before or after");
  }
  const sampledAt = record.sampledAt;
  if (typeof sampledAt !== "number" || !Number.isFinite(sampledAt)) {
    throw new TypeError("usage boundary sample time must be finite");
  }
  return {
    turnId,
    phase,
    sampledAt,
    result: parseUsageResult(record.result),
  };
}

export function parseSessionIdentity(value: unknown): SessionIdentity {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("session identity must be an object");
  }
  // Older renderers did not carry a lane field. Treat those responses as the
  // original single-session lane while keeping every new host response
  // explicit and stable.
  const laneValue = record.laneId;
  if (laneValue !== undefined && typeof laneValue !== "string") {
    throw new Error("laneId must be a string when provided");
  }
  const laneId = typeof laneValue === "string" && laneValue.trim().length > 0
    ? laneValue.trim()
    : "lane-1";
  const runtimeId = requiredString(record, "runtimeId");
  const sessionId = requiredString(record, "sessionId");
  const cwd = requiredString(record, "cwd");
  const model = record.model;
  if (model !== undefined && typeof model !== "string") {
    throw new Error("session model must be a string");
  }
  const voyagePath = record.voyagePath;
  if (voyagePath !== undefined && typeof voyagePath !== "string") {
    throw new Error("voyagePath must be a string when provided");
  }
  return {
    laneId,
    runtimeId,
    sessionId,
    cwd,
    ...(model === undefined ? {} : { model }),
    ...(voyagePath === undefined ? {} : { voyagePath }),
  };
}

function parseTurnOutcome(value: unknown): TurnOutcome {
  const record = recordOf(value);
  if (record === null || typeof record.kind !== "string") {
    throw new Error("invalid turn outcome");
  }
  switch (record.kind) {
    case "completed":
      return { kind: "completed" };
    case "aborted":
      return { kind: "aborted" };
    case "failed": {
      const reason = requiredString(record, "reason");
      const failure = record.failure;
      switch (failure) {
        case "auth":
        case "quota":
        case "invalid_request":
        case "overloaded":
        case "provider":
        case "runtime_exited":
        case "unknown":
          return { kind: "failed", reason, failure };
        default:
          throw new Error("invalid turn failure class");
      }
    }
    default:
      throw new Error("unknown turn outcome kind");
  }
}

function parseRunningPhase(value: unknown): RunningPhase {
  if (typeof value === "string") {
    switch (value) {
      case "waiting_model":
      case "thinking":
      case "responding":
        return value;
      default:
        throw new Error("unknown agent phase");
    }
  }
  const record = recordOf(value);
  if (record === null) {
    throw new Error("invalid agent phase");
  }
  return {
    tool: requiredString(record, "tool"),
    callId: requiredString(record, "callId"),
  };
}

function parseAgentView(value: unknown): AgentViewUpdate {
  const record = recordOf(value);
  if (record === null || typeof record.simple !== "string") {
    throw new Error("fleet lane view must be an agent view");
  }
  let simple: AgentViewUpdate["simple"] = "idle";
  switch (record.simple) {
    case "idle":
    case "busy":
    case "stuck":
    case "error":
      simple = record.simple;
      break;
    default:
      throw new Error("unknown simple agent state");
  }
  const statusRecord = recordOf(record.status);
  if (statusRecord === null || typeof statusRecord.kind !== "string") {
    throw new Error("agent view must contain a status");
  }
  const stallRecord = record.stall;
  const stall = stallRecord === null
    ? null
    : ((): { readonly turnId: string; readonly silentForMs: number } => {
        const parsed = recordOf(stallRecord);
        if (parsed === null) {
          throw new Error("agent view contains an invalid stall");
        }
        return {
          turnId: requiredString(parsed, "turnId"),
          silentForMs: typeof parsed.silentForMs === "number"
            ? parsed.silentForMs
            : ((): number => { throw new Error("stall duration must be a number"); })(),
        };
      })();
  switch (statusRecord.kind) {
    case "idle": {
      const outcome = statusRecord.lastTurnOutcome;
      return {
        status: outcome === undefined
          ? { kind: "idle" }
          : { kind: "idle", lastTurnOutcome: parseTurnOutcome(outcome) },
        stall,
        simple,
      };
    }
    case "running":
      return {
        status: {
          kind: "running",
          turnId: requiredString(statusRecord, "turnId"),
          phase: parseRunningPhase(statusRecord.phase),
          lastEventAt: typeof statusRecord.lastEventAt === "number"
            ? statusRecord.lastEventAt
            : (() => { throw new Error("last event time must be a number"); })(),
        },
        stall,
        simple,
      };
    default:
      throw new Error("unknown agent status kind");
  }
}

export function parseFleetSnapshot(value: unknown): FleetSnapshot {
  const record = recordOf(value);
  if (record === null || !Array.isArray(record.lanes)) {
    throw new Error("fleet response must contain lanes");
  }
  const lanes: LaneSnapshot[] = record.lanes.map((laneValue): LaneSnapshot => {
    const lane = recordOf(laneValue);
    if (lane === null) {
      throw new Error("fleet lane must be an object");
    }
    const activeTurnId = lane.activeTurnId;
    if (activeTurnId !== undefined && typeof activeTurnId !== "string") {
      throw new Error("activeTurnId must be a string when provided");
    }
    const view = lane.view;
    if (typeof view !== "object" || view === null) {
      throw new Error("fleet lane must contain a view");
    }
    const snapshot: LaneSnapshot = {
      identity: parseSessionIdentity(lane.identity),
      view: parseAgentView(view),
    };
    if (activeTurnId !== undefined) {
      return Object.assign(snapshot, { activeTurnId });
    }
    return snapshot;
  });
  return { lanes };
}

export function parseSubmitReceipt(value: unknown): SubmitReceipt {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("submit receipt must be an object");
  }
  switch (record.landed) {
    case "prompted":
    case "steered":
    case "queued":
      return { landed: record.landed, turnId: requiredString(record, "turnId") };
    case "rejected":
      return { landed: "rejected", reason: requiredString(record, "reason") };
    default:
      throw new Error("unknown submit landing");
  }
}

export function parseAbortReceipt(value: unknown): AbortReceipt {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("abort receipt must be an object");
  }
  return { aborted: requiredBoolean(record, "aborted") };
}
