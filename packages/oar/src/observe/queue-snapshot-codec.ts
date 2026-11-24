import type { InputImage, InputOrigin, RejectionCode } from "../contracts/session.js";
import type { ConversationInput } from "./conversation.js";
import { asRecord, type JsonRecord } from "../shared/json.js";
import {
  QUEUE_SNAPSHOT_FORMAT,
  QUEUE_SNAPSHOT_VERSION,
  type QueueSnapshot,
  type QueueSnapshotAction,
  type QueueSnapshotAttempt,
  type QueueSnapshotEntry,
  type QueueSnapshotEvidence,
  type QueueSnapshotEvidenceCode,
  type QueueSnapshotOwnership,
  type QueueSnapshotStream,
} from "./queue-snapshot.js";

/** Why a stored snapshot was refused. Nothing is repaired or guessed. */
export type QueueSnapshotErrorCode = "invalid_shape" | "unknown_format" | "unsupported_version" | "duplicate_entry";

/** A stored snapshot this reader will not act on. `path` names the field, so a host can report it. */
export class QueueSnapshotError extends Error {
  override readonly name: string = "QueueSnapshotError";
  readonly code: QueueSnapshotErrorCode;
  readonly path: string;

  constructor(code: QueueSnapshotErrorCode, path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.code = code;
    this.path = path;
  }
}

// Kept in step with the contracts they validate; a reader refuses what it does not know rather than guessing.
const STATES: readonly ConversationInput["state"][] = ["pending", "accepted", "rejected", "withdrawn", "dropped", "untracked"];
const REASONS: readonly NonNullable<ConversationInput["reason"]>[] = ["turn_interrupted", "runtime_exited", "runtime_refused"];
const ACTIONS: readonly QueueSnapshotAction[] = ["prompt", "steer", "queue", "withdraw"];
const ATTEMPT_STATES: readonly QueueSnapshotAttempt["state"][] = ["pending", "accepted", "rejected"];
const REJECTION_CODES: readonly RejectionCode[] = [
  "aborted", "busy", "no_active_turn", "not_queued", "unsupported", "runtime_exited",
  "session_released", "disposed", "runtime_refused", "session_not_found", "error",
];
const OWNERSHIPS: readonly QueueSnapshotOwnership[] = ["caller", "held_by_oar", "held_by_runtime", "delivered", "unknown"];
const RESENDS: readonly QueueSnapshotEvidence["resend"][] = ["safe", "uncertain", "never"];
const EVIDENCE_CODES: readonly QueueSnapshotEvidenceCode[] = [
  "refused", "withdrawn", "discarded", "adapter_queue_lost", "unobserved", "exit_without_echo",
  "delivered", "held_by_oar", "held_by_runtime", "unnamed_input", "not_a_queue_input",
];
const ORIGIN_KINDS: readonly InputOrigin["kind"][] = ["user", "notification", "automation"];
const TURN_STATES: readonly NonNullable<QueueSnapshotEntry["turn"]>["state"][] = ["queued", "active"];

/**
 * Read a persisted snapshot back (docs/spec/queue-snapshot.md). The document
 * is the host's JSON: `parseQueueSnapshot(JSON.parse(stored))`. Unknown extra
 * fields are ignored; a foreign format, another version, a missing or
 * ill-typed field, or two entries for one input is refused with a
 * `QueueSnapshotError`, never repaired. The `evidence` block is trusted as
 * written — it is what makes the document self-describing — so a document
 * without it is refused instead of guessed.
 */
export function parseQueueSnapshot(value: unknown): QueueSnapshot {
  const document = recordOf(value, "snapshot");
  return { format: formatOf(document), version: versionOf(document), stream: streamOf(document.stream), entries: entriesOf(document.entries) };
}

function formatOf(document: JsonRecord): typeof QUEUE_SNAPSHOT_FORMAT {
  const value = document.format;
  if (value !== QUEUE_SNAPSHOT_FORMAT) { throw new QueueSnapshotError("unknown_format", "format", `expected "${QUEUE_SNAPSHOT_FORMAT}", got ${describe(value)}`); }
  return QUEUE_SNAPSHOT_FORMAT;
}

function versionOf(document: JsonRecord): typeof QUEUE_SNAPSHOT_VERSION {
  const value = document.version;
  if (value !== QUEUE_SNAPSHOT_VERSION) {
    throw new QueueSnapshotError("unsupported_version", "version", `expected ${QUEUE_SNAPSHOT_VERSION}, got ${describe(value)}`);
  }
  return QUEUE_SNAPSHOT_VERSION;
}

function streamOf(value: unknown): QueueSnapshotStream {
  const stream = recordOf(value, "stream");
  return {
    streamId: textOf(stream, "streamId", "stream.streamId"),
    sessionId: textOf(stream, "sessionId", "stream.sessionId"),
    lastSeq: seqOf(stream, "lastSeq", "stream.lastSeq"),
  };
}

function entriesOf(value: unknown): readonly QueueSnapshotEntry[] {
  if (!Array.isArray(value)) { throw new QueueSnapshotError("invalid_shape", "entries", "an array is required"); }
  const items: unknown[] = value;
  const entries: QueueSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const entry = entryOf(item, `entries[${index}]`);
    // The fold's identity for input a request carried without one is that request's id.
    const identity = entry.inputId ?? entry.attempts[0]?.requestId ?? "";
    const key = JSON.stringify([entry.agentPath, identity]);
    if (seen.has(key)) {
      throw new QueueSnapshotError("duplicate_entry", `entries[${index}].inputId`, `${identity === "" ? "an entry with no inputId or attempts" : identity} appears twice in one agent lane`);
    }
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

function entryOf(value: unknown, path: string): QueueSnapshotEntry {
  const entry = recordOf(value, path);
  const inputId = optionalTextOf(entry, "inputId", `${path}.inputId`);
  const reason = optionalOneOf(entry.reason, REASONS, `${path}.reason`);
  return {
    ...(inputId === undefined ? {} : { inputId }),
    input: textOf(entry, "input", `${path}.input`),
    ...(entry.images === undefined ? {} : { images: imagesOf(entry.images, `${path}.images`) }),
    ...(entry.origin === undefined ? {} : { origin: originOf(entry.origin, `${path}.origin`) }),
    ...(entry.carries === undefined ? {} : { carries: stringsOf(entry.carries, `${path}.carries`) }),
    agentPath: stringsOf(entry.agentPath, `${path}.agentPath`),
    state: oneOf(entry.state, STATES, `${path}.state`),
    ...(reason === undefined ? {} : { reason }),
    attempts: attemptsOf(entry.attempts, `${path}.attempts`),
    evidence: evidenceOf(entry.evidence, `${path}.evidence`),
    ...(entry.turn === undefined ? {} : { turn: turnOf(entry.turn, `${path}.turn`) }),
  };
}

function imagesOf(value: unknown, path: string): readonly InputImage[] {
  if (!Array.isArray(value)) { throw new QueueSnapshotError("invalid_shape", path, "an array is required"); }
  const items: unknown[] = value;
  const images: InputImage[] = [];
  for (const [index, item] of items.entries()) {
    const image = recordOf(item, `${path}[${index}]`);
    const mediaType = optionalTextOf(image, "mediaType", `${path}[${index}].mediaType`);
    const read = { path: textOf(image, "path", `${path}[${index}].path`) };
    images.push(mediaType === undefined ? read : { ...read, mediaType });
  }
  return images;
}

function originOf(value: unknown, path: string): InputOrigin {
  const origin = recordOf(value, path);
  const source = optionalTextOf(origin, "source", `${path}.source`);
  return { kind: oneOf(origin.kind, ORIGIN_KINDS, `${path}.kind`), ...(source === undefined ? {} : { source }) };
}

function attemptsOf(value: unknown, path: string): readonly QueueSnapshotAttempt[] {
  if (!Array.isArray(value)) { throw new QueueSnapshotError("invalid_shape", path, "an array is required"); }
  const items: unknown[] = value;
  const attempts: QueueSnapshotAttempt[] = [];
  for (const [index, item] of items.entries()) {
    const at = `${path}[${index}]`;
    const attempt = recordOf(item, at);
    const code = optionalOneOf(attempt.code, REJECTION_CODES, `${at}.code`);
    const reason = optionalTextOf(attempt, "reason", `${at}.reason`);
    const heldBy = attempt.heldBy === undefined ? undefined : heldOneOf(attempt.heldBy, `${at}.heldBy`);
    const read = {
      requestId: textOf(attempt, "requestId", `${at}.requestId`),
      action: oneOf(attempt.action, ACTIONS, `${at}.action`),
      seq: seqOf(attempt, "seq", `${at}.seq`),
      streamId: textOf(attempt, "streamId", `${at}.streamId`),
      state: oneOf(attempt.state, ATTEMPT_STATES, `${at}.state`),
    };
    attempts.push({
      ...read,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
      ...(heldBy === undefined ? {} : { heldBy }),
    });
  }
  return attempts;
}

function heldOneOf(value: unknown, path: string): "adapter" {
  if (value !== "adapter") { throw new QueueSnapshotError("invalid_shape", path, `expected "adapter", got ${describe(value)}`); }
  return "adapter";
}

function evidenceOf(value: unknown, path: string): QueueSnapshotEvidence {
  const block = recordOf(value, path);
  return {
    ownership: oneOf(block.ownership, OWNERSHIPS, `${path}.ownership`),
    resend: oneOf(block.resend, RESENDS, `${path}.resend`),
    code: oneOf(block.code, EVIDENCE_CODES, `${path}.code`),
    inputIdSeenByRuntime: booleanOf(block.inputIdSeenByRuntime, `${path}.inputIdSeenByRuntime`),
  };
}

function turnOf(value: unknown, path: string): NonNullable<QueueSnapshotEntry["turn"]> {
  const turn = recordOf(value, path);
  return { state: oneOf(turn.state, TURN_STATES, `${path}.state`), seq: seqOf(turn, "seq", `${path}.seq`), streamId: textOf(turn, "streamId", `${path}.streamId`) };
}

function recordOf(value: unknown, path: string): JsonRecord {
  const record = asRecord(value);
  if (record === null) { throw new QueueSnapshotError("invalid_shape", path, "a JSON object is required"); }
  return record;
}

function textOf(record: JsonRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) { throw new QueueSnapshotError("invalid_shape", path, "a non-empty string is required"); }
  return value;
}

function optionalTextOf(record: JsonRecord, key: string, path: string): string | undefined {
  return record[key] === undefined ? undefined : textOf(record, key, path);
}

function stringsOf(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string")) {
    throw new QueueSnapshotError("invalid_shape", path, "an array of strings is required");
  }
  const items: unknown[] = value;
  return items.filter((item): item is string => typeof item === "string");
}

function seqOf(record: JsonRecord, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    throw new QueueSnapshotError("invalid_shape", path, "a safe integer of at least -1 is required");
  }
  return value;
}

function booleanOf(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") { throw new QueueSnapshotError("invalid_shape", path, `a boolean is required, got ${describe(value)}`); }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const found = typeof value === "string" ? allowed.find((candidate) => candidate === value) : undefined;
  if (found === undefined) { throw new QueueSnapshotError("invalid_shape", path, `one of ${allowed.join(", ")} is required, got ${describe(value)}`); }
  return found;
}

function optionalOneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined {
  return value === undefined ? undefined : oneOf(value, allowed, path);
}

/** A short description of an offending value; never its content beyond a short string. */
function describe(value: unknown): string {
  if (typeof value === "string") { return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value); }
  if (typeof value === "number" || typeof value === "boolean") { return String(value); }
  if (value === null) { return "null"; }
  return Array.isArray(value) ? "an array" : typeof value;
}
