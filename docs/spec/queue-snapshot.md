# Queue snapshots: a host-owned durable queue

OAR holds no storage and restores no queue on its own. What it supplies is a
versioned, JSON-safe snapshot of the queue facts a host already has in its own
log, a validating reader, a restore plan, and one call that resends only what
the stream returned to the caller. The host decides when to snapshot, where to
keep it, and whether to restore; OAR never becomes the application's database
([replay boundary](../design/foundations.md#replay-boundary),
[no storage layer](../design/decisions.md#a-storage-layer-2026-09-03)).

```ts
import { parseQueueSnapshot, queueSnapshotOf, restoreQueue } from "@botiverse/oar/observe";

// Any time after a queue change: derive it from the records the host already persists.
const snapshot = queueSnapshotOf(session.records(), { streamId, sessionId: session.id });
host.write("queue.json", JSON.stringify(snapshot));

// After a restart, on the reopened (resumed) session:
const restored = await restoreQueue(session, parseQueueSnapshot(host.read("queue.json")), {
  streamId: newStreamId,            // this open's stream; OAR seq restarts at 0 on resume
  inputId: () => crypto.randomUUID(), // fresh ids for input the runtime may already have seen
});
restored.resent;  // the queue calls actually made, with their answers
restored.skipped; // everything else, each with its typed reason
```

## Why this is not durable queue storage

A snapshot is a **projection**, not a log: everything in it is derived from
records the host already keeps, so it can be regenerated at any time and a
corrupt one can be thrown away. It carries no product data, no credentials, no
native payloads, and no auth or account state. Persistence, retention, indexes
and replay remain the application's ([conversation](conversation.md#browser-safe-reducer)).

The boundary is also about what OAR will **not** do:

- It never writes a snapshot anywhere, and never reads one back on its own.
- It never restores a queue implicitly: opening or resuming a session does not
  consult a snapshot.
- It never resends input it cannot prove the caller owns. A restored input is
  only ever queued again through the ordinary `Session.queue()` call, with the
  original text, image paths and origin.

Native durable queues are a different thing and are left where they are:
Codex's queue lives in its own session, and a snapshot says so rather than
trying to move it.

## The document

`QueueSnapshot` is plain JSON: `JSON.stringify(snapshot)` is the stored form and
`parseQueueSnapshot(JSON.parse(text))` the read.

```ts
interface QueueSnapshot {
  readonly format: "oar.queue-snapshot";  // a reader refuses anything else
  readonly version: 1;                    // any other version is refused, not migrated
  readonly stream: QueueSnapshotStream;
  readonly entries: readonly QueueSnapshotEntry[]; // fold order
}
interface QueueSnapshotStream {
  readonly streamId: string;   // the host's name for one open: a new one per open or resume
  readonly sessionId: string;  // the runtime-native session these entries belong to
  readonly lastSeq: number;    // the cursor the snapshot reflects; -1 before any record
  readonly ended?: { readonly kind: "exited" | "released"; readonly seq: number };
}
interface QueueSnapshotEntry {
  readonly inputId?: string;                  // absent only for records that carried none
  readonly input: string;                     // exactly as the request carried it, never trimmed
  readonly images?: readonly InputImage[];    // paths on the machine the runtime ran on
  readonly origin?: InputOrigin;              // `user` / `notification` / `automation`
  readonly carries?: readonly string[];       // inputs an aggregate prompt delivered with it
  readonly agentPath: readonly string[];      // sub-agent lineage inside the session
  readonly state: ConversationInput["state"]; // the fold's own reading
  readonly reason?: "turn_interrupted" | "runtime_exited" | "runtime_refused";
  readonly attempts: readonly QueueSnapshotAttempt[];
  readonly evidence: QueueSnapshotEvidence;
  readonly turn?: { readonly state: "queued" | "active"; readonly seq: number; readonly streamId: string };
}
interface QueueSnapshotAttempt {
  readonly requestId: string;
  readonly action: "prompt" | "steer" | "queue" | "withdraw";
  readonly seq: number;
  readonly streamId: string;
  readonly state: "pending" | "accepted" | "rejected"; // pending: the outcome was never observed
  readonly code?: RejectionCode;
  readonly reason?: string;
  readonly heldBy?: "adapter";  // an accepted response's own word that OAR, not the runtime, held it
}
interface QueueSnapshotEvidence {
  readonly ownership: "caller" | "held_by_oar" | "held_by_runtime" | "delivered" | "unknown";
  readonly resend: "safe" | "uncertain" | "never";
  readonly code: QueueSnapshotEvidenceCode;
  readonly inputIdSeenByRuntime: boolean;
}
```

`streamId` and `lastSeq` are the cursor identity: the same pair `Cursor` names
(`{ sessionId, afterSeq }`), plus the host's stream name, because a resume
restarts `seq` at 0 and only the host can tell two streams apart. Attempts keep
the `streamId` they were folded under for the same reason.

A snapshot covers **one native session**. A derived child session in the same
stream (`sessionId` of its own) is that child's snapshot; `lastSeq` still
covers the whole stream, because that is the cursor. Inputs seen only through a
native echo, with no observed request, are left out: the host never owned them
and cannot resend them.

Snapshots stay complete under `retainedBytes`: elision removes frame `native`
payloads and tool input/output only, and never a request, a response, or the
event kinds (`input_queued`, `input_dropped`, `user_message`) this projection
reads ([bounded retention](record-stream.md#bounding-retained-records)).

## Delivery evidence

Every entry carries one explicit reading, and a restore branches on it and on
nothing else. No verdict is inferred from a turn end, from text, or from a
native echo of a different input.

| Stream evidence | `ownership` | `resend` | `code` |
| --- | --- | --- | --- |
| The queue attempt was refused (the only attempt) | `caller` | `safe` | `refused` |
| An accepted withdraw followed the held queue attempt | `caller` | `safe` | `withdrawn` |
| The runtime discarded or refused an accepted queue input (`input_dropped`) | `caller` | `safe` | `discarded` |
| An adapter-held queue (`queued: "adapter"`) and the session ended (`exited` or `released`) | `caller` | `safe` | `adapter_queue_lost` |
| Accepted queue with no observed outcome (`pending`) | `unknown` | `uncertain` | `unobserved` |
| Runtime-held queue settled by an exit whose echoes this stream cannot see | `unknown` | `uncertain` | `exit_without_echo` |
| A dispatch prompt carried it; `prompt`/`steer` accepted; an active native turn; a native echo; `input_handled` | `delivered` | `never` | `delivered` |
| Accepted into an adapter-held queue that never dispatched | `held_by_oar` | `never` | `held_by_oar` |
| Accepted into the runtime's own queue, or natively queued (`input_queued`) | `held_by_runtime` | `never` | `held_by_runtime` |
| A request carried no `inputId` | as read | `never` | `unnamed_input` |
| The latest attempt was a `prompt` or `steer`, not a queue | as read | `never` | `not_a_queue_input` |

Three deliberate choices sit behind that table:

- **A lost adapter queue is certain, not probable.** `queued: "adapter"` is the
  accepted response's own statement that OAR held the entry, and dispatch is a
  later prompt the stream would show. When the session then ends, nothing was
  sent, so ownership returns even though the fold alone cannot settle it.
- **A runtime-held queue is never resent, not even after an exit.** Codex's
  durable queue may survive in the native session; `runtime_exited` says only
  that no echo was observed
  ([dropped input](conversation.md#dropped-input)). The host that must resend
  can do it itself, with full knowledge of the reopened transcript.
- **A prompt or steer is never turned into a queue.** Restoring is "hold this
  for a later turn"; a rejected prompt asked for a turn now, and changing that
  silently would be OAR deciding the host's delivery policy. It is reported,
  not resent.

`inputIdSeenByRuntime` is true when any attempt for the input may have handed
the logical id to the runtime: an accepted `prompt`/`steer`, an accepted queue
the runtime itself took, or any unanswered attempt. It is false for an accepted
adapter-held queue (the runtime never saw it) and for refused attempts. Claude
refuses a reused UUID, and every runtime may treat a repeated id as the same
input, so a resend of a seen id must mint a fresh one.

## Reading a stored snapshot

`parseQueueSnapshot` refuses what it cannot vouch for, with a
`QueueSnapshotError` whose `code` and `path` say what was wrong:

| `code` | When |
| --- | --- |
| `unknown_format` | `format` is not `oar.queue-snapshot` |
| `unsupported_version` | `version` is not `1`; no migration is attempted |
| `duplicate_entry` | two entries name one `inputId` in one agent lane |
| `invalid_shape` | a missing or ill-typed field, including a missing `evidence` block |

Unknown **extra** fields are ignored, so a newer writer may add them; a reader
never guesses a field it does not understand, and never re-derives `evidence`.
The evidence block is what makes the document self-describing: a snapshot
without it is refused rather than re-classified with a later OAR's rules.

## Restoring

`queueSnapshotPlan(snapshot, target, options?)` decides without sending
anything, and `restoreQueue(session, snapshot, options)` applies it against a
live session. `target` is `{ sessionId, streamId?, records? }`; `restoreQueue`
builds it from the session's `id`, the caller's `streamId`, and any `prior`
records of the reopened stream.

| `plan.status` | Meaning | Sends |
| --- | --- | --- |
| `ready` | entries were decided | the ones marked `resend: true` |
| `current` | the target stream already holds this snapshot's cursor: a checkpoint, not a restore | nothing |
| `blocked` | `foreign_session` (another native session) or `stale_snapshot` (the snapshot is ahead of the stream that claims to be the same one) | nothing |

Per entry, a `resend: false` decision carries one code: the evidence's own
(`never` codes, `unconfirmed` for `uncertain` without the host's consent) or a
target finding:

| `code` | When |
| --- | --- |
| `child_lane` | the input belongs to a sub-agent lane (`agentPath` non-empty). `Session.queue` records the ROOT lane — `InputOptions` names no sub-agent — so a child lane's input cannot be delivered from this session and is never resent. |
| `duplicate_input` | the target stream already names that input, so a second restore, or an input the host already re-queued, is refused. Checked for the entry's own id and again for the outgoing one. |
| `input_id_collision` | the outgoing id names another entry of this snapshot, or two planned entries would send under it. Both are refused: one id folds two inputs into one. |
| `invalid_input_id` | the outgoing id is not a UUID. `sealSession` requires that shape of every prompt, steer and queue, so a restore refuses it here instead of letting the queue call throw mid-batch. |
| `input_id_reused` | the runtime may already know the id and the outgoing id is still that one (no fresh id, or the host handed back the same one). |
| `already_current` | the snapshot is a checkpoint of the target's own stream. |
| `plan_blocked` | the whole snapshot was refused. |

`restoreQueue` then queues each planned entry **in snapshot order**, one awaited
`Session.queue()` per entry, with `inputId`, `images` and `origin` as recorded.
A rejected queue call is reported with its code in `restored.resent` and the
loop continues; nothing is retried, and nothing is resent for `pending`
attempts unless the host passed `allowUncertain`. A restored input is a new
attempt in the new stream: the old queue request, its response and its
withdrawal stay in the host's log exactly as they were.

```ts
const plan = queueSnapshotPlan(snapshot, { sessionId: session.id, streamId: "open-7" });
plan.entries.map((entry) => entry.resend ? entry.inputId : entry.code);
// ["held_by_oar", "delivered", "input_id_reused", ...] — the host can show why each input waits or does not.
```

## Limits and runtime notes

- **No storage, no scheduling.** OAR keeps nothing and wakes nothing; an
  application that wants queued input to run after a restart must restore it
  and start the turn itself (`deliver` or `prompt`).
- **Adapter-held queues only for `safe` + same id.** Runtimes whose accepted
  queue response does not carry `queued: "adapter"` are read as
  `held_by_runtime`: their inputs are never resent automatically, and their ids
  count as possibly seen. That is the conservative side of an adapter that does
  not declare where its queue lives.
- **Codex, pi-durable and DSH** hold queues natively; a snapshot never moves
  one. `withdraw` is absent or native there, so the cases that produce `safe`
  evidence (withdraw, adapter loss) are the adapter-held ones.
- **`runtime_exited` is not proof of non-delivery.** It settles an input the
  adapter itself held and reports `uncertain` for one the runtime held.
- **Images are paths**, never bytes: a restored input references the same files
  it always did. A host that moved or deleted them gets the runtime's own
  refusal on delivery, not a silent substitution.
- **Session identity is a precondition.** A snapshot is restored into the same
  runtime-native session (`resume`). A different id is `foreign_session`: input
  ids, lanes and native queues do not transfer between conversations.
- **Root lane only.** A restore delivers through `Session.queue`, which records
  the root agent's lane. Sub-agent lanes are captured as evidence and never
  restored (`child_lane`) until an OAR control names a lane target; a host that
  wants a child lane's input delivered must do it through that child's own
  session.
- **The document is as sensitive as the conversation.** It carries the input
  text, image paths and origin verbatim, so a host that logs or ships
  `queue.json` exports conversation content. Store it beside the records it was
  derived from, under the same retention and access rules.

## Evidence

Unit coverage is `tests/queue-snapshot.test.ts` (projection, codec, scope) and
`tests/queue-restore.test.ts` (plan, restore, live mock session), including the
child-lane refusal and the outgoing-id rules (a fresh id the target names,
shared by two resends, naming another entry, or not a UUID). The behavior suite
pins the promise every runtime must keep with
`session.queue-snapshot-restores-only-returned-input`, which accepts either
withdraw outcome of the race and asserts that nothing with `resend: "never"`
was ever queued.
