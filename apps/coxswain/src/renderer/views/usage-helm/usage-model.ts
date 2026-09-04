import type {
  UsageBoundaryView,
  UsageResult,
  UsageSnapshotView,
  UsageWindowView,
} from "../../../shared/ipc.js";

/** The states an account-usage observation can honestly expose to the UI. */
export type UsageHelmStatus =
  | "pending"
  | "available"
  | "unsupported"
  | "reauth_required"
  | "unavailable"
  | "error";

export interface UsageWindowDeltaView {
  readonly label: string;
  readonly beforeRatio?: number;
  readonly afterRatio?: number;
  /** Signed consumed-fraction change; absent when there is no matching baseline. */
  readonly deltaRatio?: number;
  /** Positive consumed-fraction points per minute, when a useful rate exists. */
  readonly burnRatePerMinute?: number;
  /** Absolute epoch milliseconds when the current burn would reach 100%. */
  readonly projectedLimitAt?: number;
  /** True when a reset/adjustment lowered the observed consumed fraction. */
  readonly reset: boolean;
  /** True when the next reset arrives before the projected limit. */
  readonly resetBeforeProjection: boolean;
  readonly resetsAt?: string;
}

export interface TurnUsageView {
  readonly turnId: string;
  readonly status: UsageHelmStatus;
  readonly beforeAt?: number;
  readonly afterAt?: number;
  readonly elapsedMs?: number;
  readonly windows: readonly UsageWindowDeltaView[];
  readonly plan?: string;
  readonly rateLimited?: boolean;
  readonly reason?: string;
}

function statusOfResult(result: UsageResult): UsageHelmStatus {
  if (result.kind === "unavailable" || result.kind === "error") {
    return result.kind;
  }
  switch (result.usage.kind) {
    case "available":
      return "available";
    case "reauth_required":
      return "reauth_required";
    case "unsupported":
      return "unsupported";
  }
  throw new Error("Unknown usage snapshot kind");
}

function reasonOfResult(result: UsageResult): string | undefined {
  switch (result.kind) {
    case "unavailable":
    case "error":
      return result.reason;
    case "loaded":
      switch (result.usage.kind) {
        case "reauth_required":
          return "sign in again to inspect account usage";
        case "unsupported":
          return "account usage is not exposed by this runtime";
        case "available":
          return undefined;
      }
  }
  throw new Error("Unknown usage result kind");
}

type AvailableUsage = Extract<UsageSnapshotView, { readonly kind: "available" }>;

function availableSnapshot(result: UsageResult | undefined): AvailableUsage | undefined {
  return result?.kind === "loaded" && result.usage.kind === "available"
    ? result.usage
    : undefined;
}

function finiteResetAt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

interface PriorWindow {
  readonly window: UsageWindowView;
  readonly index: number;
}

interface WindowPair {
  readonly current?: UsageWindowView;
  readonly previous?: PriorWindow;
}

interface WindowProjection {
  readonly projectedLimitAt?: number;
  readonly resetBeforeProjection: boolean;
}

function projectWindowLimit(
  current: UsageWindowView | undefined,
  burnRatePerMinute: number | undefined,
  afterAt: number | undefined,
  resetAt: number | undefined,
): WindowProjection {
  if (current === undefined
    || burnRatePerMinute === undefined
    || afterAt === undefined
    || current.usedRatio >= 1) {
    return { resetBeforeProjection: false };
  }
  const candidate = afterAt + ((1 - current.usedRatio) / burnRatePerMinute) * 60_000;
  return resetAt !== undefined && resetAt > afterAt && candidate >= resetAt
    ? { resetBeforeProjection: true }
    : { resetBeforeProjection: false, projectedLimitAt: candidate };
}

/**
 * Pair windows by their runtime-provided label, preserving duplicate labels by
 * occurrence. Labels are the only stable identity exposed by accountUsage.
 */
function pairWindows(
  before: readonly UsageWindowView[],
  after: readonly UsageWindowView[],
): readonly WindowPair[] {
  const byLabel = new Map<string, PriorWindow[]>();
  before.forEach((window, index) => {
    const list = byLabel.get(window.label);
    const prior = { window, index };
    if (list === undefined) {
      byLabel.set(window.label, [prior]);
    } else {
      list.push(prior);
    }
  });
  const consumed = new Set<number>();
  const pairs: WindowPair[] = after.map((current) => {
    const list = byLabel.get(current.label) ?? [];
    const previous = list.find((candidate) => !consumed.has(candidate.index));
    if (previous !== undefined) {
      consumed.add(previous.index);
    }
    return previous === undefined ? { current } : { current, previous };
  });
  before.forEach((window, index) => {
    if (!consumed.has(index)) {
      pairs.push({ previous: { window, index } });
    }
  });
  return pairs;
}

function windowDeltas(
  before: AvailableUsage | undefined,
  after: AvailableUsage,
  elapsedMs: number | undefined,
  afterAt: number | undefined,
): readonly UsageWindowDeltaView[] {
  const pairs = pairWindows(before?.windows ?? [], after.windows);
  const windows: UsageWindowDeltaView[] = [];
  for (const { current, previous } of pairs) {
    const label = current?.label ?? previous?.window.label;
    if (label === undefined) {
      throw new Error("Usage window pair is empty");
    }
    const delta = current === undefined || previous === undefined
      ? undefined
      : current.usedRatio - previous.window.usedRatio;
    const reset = delta !== undefined && delta < 0;
    const burnRatePerMinute = delta !== undefined
      && delta > 0
      && elapsedMs !== undefined
      && elapsedMs > 0
      ? delta / (elapsedMs / 60_000)
      : undefined;
    const resetAt = finiteResetAt(current?.resetsAt);
    const projection = projectWindowLimit(current, burnRatePerMinute, afterAt, resetAt);
    const resetsAt = current?.resetsAt ?? previous?.window.resetsAt;
    windows.push({
      label,
      ...(previous === undefined ? {} : { beforeRatio: previous.window.usedRatio }),
      ...(current === undefined ? {} : { afterRatio: current.usedRatio }),
      ...(delta === undefined ? {} : { deltaRatio: delta }),
      ...(burnRatePerMinute === undefined ? {} : { burnRatePerMinute }),
      ...(projection.projectedLimitAt === undefined ? {} : { projectedLimitAt: projection.projectedLimitAt }),
      reset,
      resetBeforeProjection: projection.resetBeforeProjection,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  return windows;
}

function pendingWindows(snapshot: AvailableUsage | undefined): readonly UsageWindowDeltaView[] {
  return snapshot?.windows.map((window) => ({
    label: window.label,
    beforeRatio: window.usedRatio,
    reset: false,
    resetBeforeProjection: false,
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  })) ?? [];
}

/**
 * Derive one turn's usage motion from the boundary observations emitted by
 * the main-process host. The raw accountUsage results stay intact in each
 * boundary; this function only adds consumer-owned comparison math.
 */
export function usageForTurn(
  boundaries: readonly UsageBoundaryView[],
  turnId: string,
): TurnUsageView | null {
  const relevant = boundaries.filter((boundary) => boundary.turnId === turnId);
  if (relevant.length === 0) {
    return null;
  }
  const before = relevant.find((boundary) => boundary.phase === "before");
  const after = relevant.findLast((boundary) => boundary.phase === "after");
  if (after === undefined) {
    const beforeStatus = before === undefined ? "pending" : statusOfResult(before.result);
    const beforeReason = before === undefined ? undefined : reasonOfResult(before.result);
    const pending: TurnUsageView = {
      turnId,
      status: beforeStatus,
      ...(before === undefined ? {} : { beforeAt: before.sampledAt }),
      windows: pendingWindows(availableSnapshot(before?.result)),
    };
    return beforeReason === undefined ? pending : { ...pending, reason: beforeReason };
  }

  const afterSnapshot = availableSnapshot(after.result);
  const beforeSnapshot = availableSnapshot(before?.result);
  const elapsedMs = before === undefined
    ? undefined
    : after.sampledAt - before.sampledAt;
  const reason = reasonOfResult(after.result);
  const base: TurnUsageView = {
    turnId,
    status: statusOfResult(after.result),
    ...(before === undefined ? {} : { beforeAt: before.sampledAt }),
    afterAt: after.sampledAt,
    ...(elapsedMs === undefined || elapsedMs < 0 ? {} : { elapsedMs }),
    windows: afterSnapshot === undefined
      ? []
      : windowDeltas(beforeSnapshot, afterSnapshot, elapsedMs, after.sampledAt),
    ...(afterSnapshot?.plan === undefined ? {} : { plan: afterSnapshot.plan }),
    ...(afterSnapshot === undefined ? {} : { rateLimited: afterSnapshot.rateLimited }),
  };
  return reason === undefined ? base : { ...base, reason };
}

/** Build a stable lookup for Conversation's outcome rows. */
export function usageViewsByTurn(
  boundaries: readonly UsageBoundaryView[],
): ReadonlyMap<string, TurnUsageView> {
  const turnIds = new Set(boundaries.map((boundary) => boundary.turnId));
  const views = new Map<string, TurnUsageView>();
  for (const turnId of turnIds) {
    const view = usageForTurn(boundaries, turnId);
    if (view !== null) {
      views.set(turnId, view);
    }
  }
  return views;
}
