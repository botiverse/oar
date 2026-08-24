import {
  utcInstantFromDate,
  type AccountUsageSnapshot,
  type AccountUsageWindow,
  type AgentStatus,
  type AgentView,
  type InstallationSnapshot,
  type RunningPhase,
  type SessionEvent,
  type SessionEventBody,
  type TurnOutcome,
} from "@botiverse/oar";

export const IPC_CHANNELS = {
  abort: "coxswain:abort",
  event: "coxswain:event",
  inspect: "coxswain:inspect",
  launch: "coxswain:launch",
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

export interface LaunchRequest {
  readonly runtimeId: string;
  readonly cwd: string;
  readonly model?: string;
}

export interface SessionIdentity {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: string;
}

export interface SubmitRequest {
  readonly text: string;
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
  | { readonly kind: "activity"; readonly event: SessionEventView }
  | { readonly kind: "agent_view"; readonly view: AgentViewUpdate }
  | { readonly kind: "conversation"; readonly entry: ConversationEntry }
  | { readonly kind: "host_error"; readonly message: string };

export interface CoxswainApi {
  inspect(): Promise<InspectResult>;
  readUsage(runtimeId: string): Promise<UsageResult>;
  launch(request: LaunchRequest): Promise<SessionIdentity>;
  submit(request: SubmitRequest): Promise<SubmitReceipt>;
  abort(): Promise<AbortReceipt>;
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
  const modelValue = record.model;
  if (modelValue !== undefined && typeof modelValue !== "string") {
    throw new Error("model must be a string when provided");
  }
  const model = typeof modelValue === "string" ? modelValue.trim() : "";
  return model.length === 0 ? { runtimeId, cwd } : { runtimeId, cwd, model };
}

export function parseSubmitRequest(value: unknown): SubmitRequest {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("submit request must be an object");
  }
  return { text: requiredString(record, "text") };
}

function requiredBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new TypeError(`${key} must be a boolean`);
  }
  return value;
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
  if (record === null || typeof record.usedRatio !== "number") {
    throw new Error("usage window must contain a numeric ratio");
  }
  const label = requiredString(record, "label");
  const resetsAt = record.resetsAt;
  if (resetsAt !== undefined && typeof resetsAt !== "string") {
    throw new Error("usage reset must be a string");
  }
  const parsedReset = typeof resetsAt === "string"
    ? utcInstantFromDate(new Date(resetsAt))
    : undefined;
  if (parsedReset === null || (typeof resetsAt === "string" && parsedReset !== resetsAt)) {
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
      const base = {
        kind: "available" as const,
        rateLimited: requiredBoolean(record, "rateLimited"),
        windows: record.windows.map(parseUsageWindow),
      };
      return plan === undefined ? base : { ...base, plan };
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

export function parseSessionIdentity(value: unknown): SessionIdentity {
  const record = recordOf(value);
  if (record === null) {
    throw new Error("session identity must be an object");
  }
  const runtimeId = requiredString(record, "runtimeId");
  const sessionId = requiredString(record, "sessionId");
  const cwd = requiredString(record, "cwd");
  const model = record.model;
  if (model !== undefined && typeof model !== "string") {
    throw new Error("session model must be a string");
  }
  return model === undefined
    ? { runtimeId, sessionId, cwd }
    : { runtimeId, sessionId, cwd, model };
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
