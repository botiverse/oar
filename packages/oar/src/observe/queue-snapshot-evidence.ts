import type { ConversationInput, InputAttempt } from "./conversation.js";
import { ownershipCut, type InputDrop } from "./input-delivery.js";
import type {
  QueueSnapshotEnding,
  QueueSnapshotEvidence,
  QueueSnapshotEvidenceCode,
  QueueSnapshotOwnership,
} from "./queue-snapshot.js";

/**
 * The stream's reading of one input, as the vocabulary a restore branches on
 * (docs/spec/queue-snapshot.md). Every verdict comes from records: an accepted
 * response, a refusal, a withdraw, a native drop, a dispatch prompt, an echo,
 * or the session's own ending. Nothing here infers delivery from a turn end or
 * from text.
 */

/** The attempt evidence a restore is decided on: ownership, whether a resend is safe, and why. */
export function queueSnapshotEvidence(input: ConversationInput, drop: InputDrop | undefined, ended: QueueSnapshotEnding | undefined): QueueSnapshotEvidence {
  const seen = seenByRuntime(input);
  const deciding = decidingAttempts(input, drop);
  const read = readOwnership(input, deciding.at(-1), deciding.findLast((attempt) => attempt.state === "accepted"), seen, ended);
  if (input.inputId !== undefined) { return read; }
  // A logical id is what a withdraw, a dispatch and a resend all name; without one there is nothing to resend under.
  return { ...read, resend: "never", code: "unnamed_input" };
}

/**
 * The attempts that still decide ownership: everything after an accepted
 * withdrawal or the attempt a drop settled; when that cut removes them all
 * (the cut itself settled one), the attempts it refers to.
 */
function decidingAttempts(input: ConversationInput, drop: InputDrop | undefined): readonly InputAttempt[] {
  const cut = ownershipCut(input.attempts, drop);
  const live = input.attempts.slice(cut + 1).filter((attempt) => attempt.request.body.kind !== "withdraw");
  // The cut can name the attempt it settled (a drop) or the withdraw that took one back.
  return live.length > 0 ? live : input.attempts.slice(0, cut + 1).filter((attempt) => attempt.request.body.kind !== "withdraw");
}

/** The runtime may have been handed this logical id, so a resend must not reuse it. An accepted adapter queue never reached it. */
function seenByRuntime(input: ConversationInput): boolean {
  return input.attempts.some(({ request, response, state }) => {
    if (request.body.kind === "withdraw" || state === "rejected") { return false; }
    return request.body.kind !== "queue" || response?.body.kind !== "accepted" || response.body.queued !== "adapter";
  });
}

function evidence(
  ownership: QueueSnapshotOwnership,
  resend: QueueSnapshotEvidence["resend"],
  code: QueueSnapshotEvidenceCode,
  inputIdSeenByRuntime: boolean,
): QueueSnapshotEvidence {
  return { ownership, resend, code, inputIdSeenByRuntime };
}

function readOwnership(
  input: ConversationInput,
  latest: InputAttempt | undefined,
  winner: InputAttempt | undefined,
  seen: boolean,
  ended: QueueSnapshotEnding | undefined,
): QueueSnapshotEvidence {
  const queued = latest !== undefined && latest.request.body.kind === "queue";
  if (input.state === "dropped") { return droppedEvidence(input, latest, winner, seen); }
  if (input.state === "accepted") { return acceptedEvidence(input, latest, winner, seen, ended); }
  if (input.state === "pending") { return queued ? evidence("unknown", "uncertain", "unobserved", seen) : evidence("unknown", "never", "not_a_queue_input", seen); }
  if (input.state === "rejected") { return queued ? evidence("caller", "safe", "refused", seen) : evidence("caller", "never", "not_a_queue_input", seen); }
  if (input.state === "withdrawn") { return queued ? evidence("caller", "safe", "withdrawn", seen) : evidence("unknown", "never", "unobserved", seen); }
  return evidence("unknown", "never", "unobserved", seen);
}

function droppedEvidence(
  input: ConversationInput,
  latest: InputAttempt | undefined,
  winner: InputAttempt | undefined,
  seen: boolean,
): QueueSnapshotEvidence {
  if (input.reason !== "runtime_exited") {
    return latest?.request.body.kind === "queue" ? evidence("caller", "safe", "discarded", seen) : evidence("caller", "never", "not_a_queue_input", seen);
  }
  if (latest?.request.body.kind !== "queue") { return evidence("delivered", "never", "delivered", seen); }
  return heldByAdapter(winner) ? evidence("caller", "safe", "adapter_queue_lost", seen) : evidence("unknown", "uncertain", "exit_without_echo", seen);
}

function acceptedEvidence(
  input: ConversationInput,
  latest: InputAttempt | undefined,
  winner: InputAttempt | undefined,
  seen: boolean,
  ended: QueueSnapshotEnding | undefined,
): QueueSnapshotEvidence {
  const decided = winner ?? latest;
  if (decided === undefined) { return evidence("unknown", "never", "unobserved", seen); }
  // A dispatch to the runtime, an active turn, a native echo or a handling
  // receipt all mean the runtime has it, whatever the queue acceptance said.
  if (decided.request.body.kind !== "queue" || input.turn?.state === "active"
    || input.disposition !== undefined || input.observations.length > 0) {
    return evidence("delivered", "never", "delivered", seen);
  }
  // Exit settles only OAR's own hold: an adapter queue died with the process
  // (or was released with it), so nothing was sent. A runtime-held queue may
  // have survived in the native session, so it is never resent.
  if (heldByAdapter(decided) && ended !== undefined) { return evidence("caller", "safe", "adapter_queue_lost", seen); }
  return heldByAdapter(decided) ? evidence("held_by_oar", "never", "held_by_oar", seen) : evidence("held_by_runtime", "never", "held_by_runtime", seen);
}

/** The accepted response said OAR, not the runtime, holds this queue entry. */
function heldByAdapter(attempt: InputAttempt | undefined): boolean {
  return attempt?.response?.body.kind === "accepted" && attempt.response.body.queued === "adapter";
}
