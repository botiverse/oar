import type { InputImage, InputOrigin, RawEvent, RejectionCode, RequestBody } from "../contracts/session.js";
import { conversationOf, type ConversationInput, type InputAttempt } from "./conversation.js";
import type { InputDrop } from "./input-delivery.js";
import { queueSnapshotEvidence } from "./queue-snapshot-evidence.js";

/**
 * The queue facts a HOST persists to restore a queue after its own restart
 * (docs/spec/queue-snapshot.md). OAR stores nothing: it derives this document
 * from records the host already keeps, validates one read back, and restores
 * through the ordinary `Session.queue` call. This file is the document and its
 * projection; the evidence classifier is ./queue-snapshot-evidence.ts, the
 * codec ./queue-snapshot-codec.ts and the restore plan ./queue-restore.ts.
 *
 * A snapshot never upgrades evidence into a delivery receipt. It carries the
 * attempts the stream holds, the fold's own state, and an explicit `evidence`
 * reading: who holds the input now, whether a resend is safe, and whether the
 * runtime already saw the logical id.
 */

/** Serialized marker; a reader refuses a document that does not carry it. */
export const QUEUE_SNAPSHOT_FORMAT = "oar.queue-snapshot";
/** Format version; bump for any incompatible change to the document. */
export const QUEUE_SNAPSHOT_VERSION = 1;
export type QueueSnapshotFormat = typeof QUEUE_SNAPSHOT_FORMAT;
export type QueueSnapshotVersion = typeof QUEUE_SNAPSHOT_VERSION;

/** How the snapshot's own session stopped, when the stream observed it (`exited`, or `released`). */
export interface QueueSnapshotEnding {
  readonly kind: "exited" | "released";
  readonly seq: number;
}

/**
 * Identity of the stream the snapshot was folded from. `streamId` is the
 * host's own name for one open (OAR seq restarts at 0 on resume), `sessionId`
 * is the runtime-native session, and `lastSeq` is the cursor the snapshot
 * reflects: the same position `Cursor.afterSeq` names.
 */
export interface QueueSnapshotStream {
  readonly streamId: string;
  readonly sessionId: string;
  /** Last `seq` folded in; -1 for a snapshot taken before any record. */
  readonly lastSeq: number;
  readonly ended?: QueueSnapshotEnding;
}

/** A delivery attempt (`prompt`, `steer`, `queue`) or the `withdraw` that took one back. */
export type QueueSnapshotAction = "prompt" | "steer" | "queue" | "withdraw";

/**
 * One attempt as the stream recorded it. `state` is the observed answer, not
 * an outcome: `pending` means the outcome was never observed. `heldBy` is the
 * accepted response's own word that OAR (not the runtime) still holds a queue
 * entry, which is what makes a lost adapter queue certain rather than probable.
 */
export interface QueueSnapshotAttempt {
  readonly requestId: string;
  readonly action: QueueSnapshotAction;
  readonly seq: number;
  readonly streamId: string;
  readonly state: "pending" | "accepted" | "rejected";
  readonly code?: RejectionCode;
  readonly reason?: string;
  readonly heldBy?: "adapter";
}

/**
 * Who holds the input now, read off the stream's evidence.
 * `caller`: ownership returned (refused, withdrawn, discarded by the runtime,
 * or an adapter-held queue the ended session can no longer dispatch).
 * `held_by_oar`: accepted into an adapter-held queue that did not dispatch it.
 * `held_by_runtime`: accepted into the runtime's own queue, or natively queued.
 * `delivered`: the runtime took it (`prompt`/`steer` accepted, a dispatch prompt
 * carried it, a native echo or handling receipt exists).
 * `unknown`: no attempt's outcome was observed.
 */
export type QueueSnapshotOwnership = "caller" | "held_by_oar" | "held_by_runtime" | "delivered" | "unknown";

/**
 * Why the evidence reads as it does. `safe`: the stream itself returned
 * ownership, so a resend cannot duplicate a runtime-held input. `uncertain`:
 * no outcome was observed. `never`: OAR or the runtime holds it, it was
 * delivered, the input has no logical id, or it was never a queue attempt.
 */
export type QueueSnapshotEvidenceCode =
  | "refused"
  | "withdrawn"
  | "discarded"
  | "adapter_queue_lost"
  | "unobserved"
  | "exit_without_echo"
  | "delivered"
  | "held_by_oar"
  | "held_by_runtime"
  | "unnamed_input"
  | "not_a_queue_input";

/** The explicit delivery evidence a restore is decided on; never inferred at read time. */
export interface QueueSnapshotEvidence {
  readonly ownership: QueueSnapshotOwnership;
  readonly resend: "safe" | "uncertain" | "never";
  readonly code: QueueSnapshotEvidenceCode;
  /** The logical id may already have reached the runtime, so a resend needs a fresh `inputId` (Claude refuses a reused one). */
  readonly inputIdSeenByRuntime: boolean;
}

/** One logical input of one session and agent lane, exactly as its requests carried it. */
export interface QueueSnapshotEntry {
  /** Absent only for input a request carried without one (older or hand-built records); such an input is never resent. */
  readonly inputId?: string;
  readonly input: string;
  readonly images?: readonly InputImage[];
  readonly origin?: InputOrigin;
  /** Logical inputs an aggregate prompt delivered with this one. */
  readonly carries?: readonly string[];
  /** Sub-agent lineage inside the session; `[]` is the root agent. */
  readonly agentPath: readonly string[];
  readonly state: ConversationInput["state"];
  readonly reason?: ConversationInput["reason"];
  readonly attempts: readonly QueueSnapshotAttempt[];
  readonly evidence: QueueSnapshotEvidence;
  /** Native queue/start evidence, separate from control acceptance. */
  readonly turn?: { readonly state: "queued" | "active"; readonly seq: number; readonly streamId: string };
}

/** A versioned, JSON-safe document a host may persist beside its own records. */
export interface QueueSnapshot {
  readonly format: QueueSnapshotFormat;
  readonly version: QueueSnapshotVersion;
  readonly stream: QueueSnapshotStream;
  /** Entries in fold order. */
  readonly entries: readonly QueueSnapshotEntry[];
}

export interface QueueSnapshotOptions {
  /** The host's name for the stream these records belong to; a new one per open or resume. */
  readonly streamId: string;
  /** The runtime-native session to snapshot. A derived child session in the same stream is its own snapshot. */
  readonly sessionId: string;
}

/**
 * Fold records into a snapshot of ONE native session. `lastSeq` covers the
 * whole stream, child sessions included, because that is the cursor; entries
 * cover only `options.sessionId`, because an input is scoped to its native
 * session. Inputs seen only through a native echo (no observed request) are
 * left out: the host never owned them and cannot resend them. Frames may be
 * `elided`, which never removes a request, a response, or the event kinds this
 * fold reads, so a snapshot is complete even from a log trimmed by
 * `retainedBytes`.
 */
export function queueSnapshotOf(records: readonly RawEvent[], options: QueueSnapshotOptions): QueueSnapshot {
  const state = conversationOf(records.filter((record) => record.sessionId === options.sessionId));
  const ended = endingOf(records, options.sessionId);
  const entries: QueueSnapshotEntry[] = [];
  for (const input of state.inputs.values()) {
    if (input.state === "untracked") { continue; }
    entries.push(entryOf(input, state.drops.get(input.id), options.streamId, ended));
  }
  const lastSeq = records.reduce((last, record) => Math.max(last, record.seq), -1);
  return {
    format: QUEUE_SNAPSHOT_FORMAT,
    version: QUEUE_SNAPSHOT_VERSION,
    stream: { streamId: options.streamId, sessionId: options.sessionId, lastSeq, ...(ended === undefined ? {} : { ended }) },
    entries,
  };
}

/** The last `exited` or `released` response the session's own stream holds. */
function endingOf(records: readonly RawEvent[], sessionId: string): QueueSnapshotEnding | undefined {
  const last = records.findLast((record) => record.sessionId === sessionId && record.kind === "response"
    && (record.body.kind === "exited" || record.body.kind === "released"));
  if (last?.kind !== "response") { return undefined; }
  return last.body.kind === "exited" ? { kind: "exited", seq: last.seq } : { kind: "released", seq: last.seq };
}

function entryOf(input: ConversationInput, drop: InputDrop | undefined, streamId: string, ended: QueueSnapshotEnding | undefined): QueueSnapshotEntry {
  const attempts = input.attempts.flatMap((attempt) => attemptOf(attempt, streamId));
  return {
    ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
    input: input.input,
    ...(input.images === undefined ? {} : { images: input.images }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.carries === undefined ? {} : { carries: input.carries }),
    // Every attempt on one input shares the lane it belongs to; the fold keys by it.
    agentPath: input.attempts[0]?.request.agentPath ?? [],
    state: input.state,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    attempts,
    evidence: queueSnapshotEvidence(input, drop, ended),
    ...(input.turn === undefined ? {} : { turn: input.turn }),
  };
}

/** The attempt as persisted, or nothing when its body is outside a queue's vocabulary (never in a fold: an attempt is an input or a withdraw). */
function attemptOf(attempt: InputAttempt, streamId: string): readonly QueueSnapshotAttempt[] {
  const action = actionOf(attempt.request.body);
  if (action === null) { return []; }
  const response = attempt.response?.body;
  const rejected = response?.kind === "rejected" ? response : undefined;
  return [{
    requestId: attempt.request.id,
    action,
    seq: attempt.request.seq,
    streamId,
    state: attempt.state,
    ...(rejected === undefined ? {} : { code: rejected.code, reason: rejected.reason }),
    ...(response?.kind === "accepted" && response.queued === "adapter" ? { heldBy: "adapter" as const } : {}),
  }];
}

function actionOf(body: RequestBody): QueueSnapshotAction | null {
  return body.kind === "prompt" || body.kind === "steer" || body.kind === "queue" || body.kind === "withdraw" ? body.kind : null;
}
