import type { ControlOutcome, RawEvent, Session } from "../contracts/session.js";
import type { QueueSnapshot, QueueSnapshotEntry, QueueSnapshotEvidenceCode } from "./queue-snapshot.js";

/**
 * Restoring a queue is a HOST decision, never an OAR habit
 * (docs/spec/queue-snapshot.md): the host persisted the snapshot beside its
 * own records, reopens the runtime-native session, and asks for a plan. A
 * planned resend happens only where the stream itself returned ownership, and
 * only through the ordinary `Session.queue` call. OAR stores nothing, retries
 * nothing on its own, and never turns an accepted input into a second copy.
 */

/** The session a snapshot is restored into: identity and the queue control, nothing else. */
export type QueueRestoreSession = Pick<Session, "id" | "queue">;

/** What a restore compares the snapshot against. */
export interface QueueSnapshotTarget {
  /** Runtime-native session the snapshot is restored into; another id is a foreign snapshot. */
  readonly sessionId: string;
  /** The stream the target already reads. The snapshot's own id means the same fold stream: a checkpoint, not a restore. */
  readonly streamId?: string;
  /** Records that stream already holds, so an input it already names is never sent again. */
  readonly records?: readonly RawEvent[];
}

/**
 * Why one entry is not resent. The first five repeat the snapshot's evidence
 * (`never` or unclear); the rest are this target's own findings: the input
 * already has an attempt in the target stream (`duplicate_input`), the stream
 * never observed the runtime's answer and the host did not take responsibility
 * (`unconfirmed`), the runtime already saw this logical id and no fresh one was
 * offered (`input_id_reused`), the snapshot is a checkpoint of this very stream
 * (`already_current`), or the whole snapshot was refused (`plan_blocked`).
 */
export type QueueSnapshotSkipCode =
  | QueueSnapshotEvidenceCode
  | "duplicate_input"
  | "unconfirmed"
  | "input_id_reused"
  | "already_current"
  | "plan_blocked";

/** One entry's decision: resend it under `inputId`, or skip it with a typed reason. */
export type QueueSnapshotPlanEntry =
  | { readonly entry: QueueSnapshotEntry; readonly resend: true; readonly inputId: string }
  | { readonly entry: QueueSnapshotEntry; readonly resend: false; readonly code: QueueSnapshotSkipCode };

export type QueueSnapshotBlockCode = "foreign_session" | "stale_snapshot";

/**
 * The whole decision, computed before anything is sent.
 * `ready`: entries were decided. `current`: the target stream already holds
 * this snapshot's cursor, so there is nothing to restore. `blocked`: the
 * snapshot belongs to another native session, or it is newer than a stream
 * that claims to be the same one, so nothing is resent.
 */
export interface QueueSnapshotPlan {
  readonly status: "ready" | "current" | "blocked";
  readonly blocked?: { readonly code: QueueSnapshotBlockCode; readonly message: string };
  readonly entries: readonly QueueSnapshotPlanEntry[];
  /** How many entries would be resent; 0 unless the status is `ready`. */
  readonly resends: number;
}

export interface QueueSnapshotPlanOptions {
  /**
   * A fresh logical inputId for a resend, and a requirement for an input the
   * runtime may already have seen: Claude refuses a reused UUID, and every
   * runtime may treat a repeated id as the same input. An empty string throws.
   */
  readonly inputId?: (entry: QueueSnapshotEntry) => string;
  /** Take responsibility for an input whose outcome the stream never observed (`uncertain`). Absent: skipped. */
  readonly allowUncertain?: (entry: QueueSnapshotEntry) => boolean;
}

export interface QueueRestoreOptions extends QueueSnapshotPlanOptions {
  /** The stream the reopened session reads. A reopened or resumed session is a NEW stream, so this is not the snapshot's id. */
  readonly streamId: string;
  /** Records that stream already holds; pass them so a second restore, or an input the host already re-queued, is refused. */
  readonly prior?: readonly RawEvent[];
}

export interface QueueRestoreResend {
  readonly entry: QueueSnapshotEntry;
  /** The logical id the resend used: the snapshot's, or the fresh one the host offered. */
  readonly inputId: string;
  /** The queue call's own answer; a rejection leaves that input with the caller. */
  readonly outcome: ControlOutcome;
}

export interface QueueRestoreResult {
  readonly plan: QueueSnapshotPlan;
  readonly resent: readonly QueueRestoreResend[];
  readonly skipped: readonly Extract<QueueSnapshotPlanEntry, { resend: false }>[];
}

/**
 * Decide, without sending anything, which snapshot entries a target could
 * restore. Pure: the same snapshot and target always yield the same plan.
 */
export function queueSnapshotPlan(snapshot: QueueSnapshot, target: QueueSnapshotTarget, options: QueueSnapshotPlanOptions = {}): QueueSnapshotPlan {
  const refusal = targetRefusal(snapshot, target);
  const current = refusal === undefined && target.streamId === snapshot.stream.streamId;
  const claimed = claimedInputs(snapshot.stream.sessionId, target.records ?? []);
  const entries = snapshot.entries.map((entry): QueueSnapshotPlanEntry => {
    if (refusal !== undefined) { return { entry, resend: false, code: "plan_blocked" }; }
    if (current) { return { entry, resend: false, code: "already_current" }; }
    return decide(entry, claimed, options);
  });
  const resends = entries.filter((planned) => planned.resend).length;
  return {
    status: refusal === undefined ? (current ? "current" : "ready") : "blocked",
    ...(refusal === undefined ? {} : { blocked: refusal }),
    entries,
    resends,
  };
}

/**
 * Restore a snapshot into a reopened session: plan, then queue every entry the
 * plan would resend, in snapshot order, one awaited call each. Nothing is sent
 * when the plan is `current` or `blocked`. A rejected queue call is reported
 * with its code and the loop continues; it is never retried here.
 */
export async function restoreQueue(session: QueueRestoreSession, snapshot: QueueSnapshot, options: QueueRestoreOptions): Promise<QueueRestoreResult> {
  const plan = queueSnapshotPlan(snapshot, {
    sessionId: session.id,
    streamId: options.streamId,
    ...(options.prior === undefined ? {} : { records: options.prior }),
  }, options);
  const resent: QueueRestoreResend[] = [];
  const skipped: Extract<QueueSnapshotPlanEntry, { resend: false }>[] = [];
  for (const planned of plan.entries) {
    if (!planned.resend) {
      skipped.push(planned);
      continue;
    }
    const { entry } = planned;
    const outcome = await session.queue(entry.input, {
      inputId: planned.inputId,
      ...(entry.images === undefined ? {} : { images: entry.images }),
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
    });
    resent.push({ entry, inputId: planned.inputId, outcome });
  }
  return { plan, resent, skipped };
}

/** A foreign session, or a snapshot newer than the same stream's own log. */
function targetRefusal(snapshot: QueueSnapshot, target: QueueSnapshotTarget): QueueSnapshotPlan["blocked"] {
  if (target.sessionId !== snapshot.stream.sessionId) {
    return { code: "foreign_session", message: `snapshot belongs to session ${snapshot.stream.sessionId}, not ${target.sessionId}` };
  }
  // Another stream on the same native session is the ordinary restore. The
  // snapshot's own stream is a checkpoint of a fold the target already has, so
  // there is nothing to restore whether or not its records were supplied.
  if (target.streamId !== snapshot.stream.streamId || target.records === undefined) { return undefined; }
  const lastSeq = target.records.reduce((last, record) => Math.max(last, record.seq), -1);
  return lastSeq >= snapshot.stream.lastSeq
    ? undefined
    : { code: "stale_snapshot", message: `stream ${snapshot.stream.streamId} holds records up to seq ${lastSeq}, before the snapshot's ${snapshot.stream.lastSeq}` };
}

function decide(entry: QueueSnapshotEntry, claimed: ReadonlySet<string>, options: QueueSnapshotPlanOptions): QueueSnapshotPlanEntry {
  const inputId = entry.inputId;
  if (inputId === undefined) { return { entry, resend: false, code: "unnamed_input" }; }
  if (entry.evidence.resend === "never") { return { entry, resend: false, code: entry.evidence.code }; }
  if (claimed.has(laneKey(entry.agentPath, inputId))) { return { entry, resend: false, code: "duplicate_input" }; }
  if (entry.evidence.resend === "uncertain" && options.allowUncertain?.(entry) !== true) { return { entry, resend: false, code: "unconfirmed" }; }
  const fresh = options.inputId?.(entry);
  if (fresh !== undefined && fresh.length === 0) { throw new TypeError(`inputId for ${inputId} must be a non-empty string`); }
  if (fresh === undefined && entry.evidence.inputIdSeenByRuntime) { return { entry, resend: false, code: "input_id_reused" }; }
  return { entry, resend: true, inputId: fresh ?? inputId };
}

/** Inputs the target stream already names: an attempt there means the input is not the caller's to resend. */
function claimedInputs(sessionId: string, records: readonly RawEvent[]): ReadonlySet<string> {
  const claimed = new Set<string>();
  for (const record of records) {
    if (record.kind !== "request" || record.direction !== "toRuntime" || record.sessionId !== sessionId) { continue; }
    const body = record.body;
    if ("input" in body && body.inputId !== undefined) { claimed.add(laneKey(record.agentPath, body.inputId)); }
  }
  return claimed;
}

function laneKey(agentPath: readonly string[], inputId: string): string {
  return JSON.stringify([agentPath, inputId]);
}
