# Steer, queue and cancellation

Local investigation, **2026-09-16**, OAR baseline **3582a52**: evidence and
design input, not a shipped cancellation capability. No authenticated turns,
logins or model requests were run. Native behavior not exercised is marked;
a missing match in a binary is never proof of absence. Reproduction and
sanitized observations: [experiments/cancellation](../../experiments/cancellation/README.md).

The [session controls matrix](../spec/runtime-matrix.md#session-controls)
describes the shipped controls. The findings below preserve the native
evidence for each examined version. Subsequent probes established Claude's
[queued cancellation](claude.md#interrupted-input) and Grok's
[queue notifications](grok.md).

## Findings

| Runtime / examined version | Steer withdrawal | Queue withdrawal |
|---|---|---|
| Codex CLI 0.154.0 | No per-steer deletion endpoint established; `turn/steer` returns a turn ID, not a cancellable input handle | **Native per-item deletion**, experimental `thread/queue/delete({threadId, queuedSubmissionId}) → {deleted}`; verified in installed schema and local source, not a live model turn |
| Claude Code 2.1.273 | **Unverified**: installed binary contains `cancel_queued`, `cancelQueued`, `interrupt_cancel_queued_v1`, `interrupt_receipt_v1`, `msg_lifecycle_v1` | Same native leads; scope, parameter shape, capability negotiation and receipts need protocol validation |
| Grok Build 1.0.30 (04b7ffed98c6) | OAR steer is `_x.ai/interject` (1.0.77, 2026-11-10); no native withdrawal of a buffered interjection; `session/cancel` clears every buffered one | **Native extension leads** in installed binary: `x.ai/queue/remove`, `clear`, `edit`, `hold_edit`, `release_edit`, `reorder`; not verified on a wire session |
| Kimi Code 0.42.0 (TypeScript harness) | Selected ACP interface has no mapped steer; no per-input withdrawal established | No per-item withdrawal established on selected ACP interface; do not generalize to every native KAP/SDK surface |
| Pi SDK 0.84.2 | **Native bulk clearing** of pending steering and follow-up messages via `AgentSession.clearQueue()`; no public per-item handle established | SDK clear applies to SDK queues; OAR's later-turn queue is a different array |
| Cursor `@cursor/sdk` 1.0.35 | `run.steer(text)` settles once the agent took the text (`complete_delivered`) or handed it back (`revert_to_followup`); SDK 1.4.0 adds `{ outcome: "queued" }`, a follow-up the SDK owns; no handle withdraws a delivered steer, and OAR has no withdrawal for an SDK-queued one | No native queue: an agent takes one run at a time and refuses a second `send` (`already has active run`) |

`queue: { durable: false }` says nothing about cancellation. Session has
`abort()` and, where OAR holds the queue, `withdraw(inputId)`, which removes
the entries held for that `inputId`; it has no `cancel(requestId)`, bulk
clear, or native queue removal
([contracts/session.ts](../../packages/oar/src/contracts/session.ts)).
Native features stay unadvertised until an adapter maps and verifies them.

## Evidence and limits by runtime

### Codex: strongest per-item native contract

Installed `codex app-server generate-json-schema --experimental` emits:

- `ThreadQueueDeleteParams`: required `threadId`, `queuedSubmissionId`.
- `ThreadQueueDeleteResponse`: required boolean `deleted`.
- `ThreadQueueAddResponse`: `queuedSubmission` (preserve its ID).
- `TurnSteerResponse`: `turnId`; `TurnInterruptParams`: `threadId`, `turnId`.

Without `--experimental` the queue method schemas are absent; omission from
the stable schema is not lack of native support.

Local Codex source at `4f39251a010a8bd7d692d25fb33832ff06f1635a`:

- `codex-rs/app-server-protocol/src/protocol/common.rs`: experimental queue methods.
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`: delete request/result.
- `codex-rs/app-server/src/request_processors/thread_queue_processor.rs`: delete
  delegates to the queue service and returns its boolean.
- `codex-rs/ext/queue/src/service.rs`: deletion and dispatch share a per-thread
  dispatch guard, and a started submission is removed from the queue. So
  `deleted: false` cannot alone distinguish already dispatched from nonexistent
  or previously deleted; it must not be reported as successful withdrawal.
- The same service's `on_thread_idle` returns early for
  `ThreadIdleCause::Interrupted`: interrupt pauses automatic draining on that
  edge rather than clearing stored queued inputs (source evidence).

Installed schema and source snapshot are separate evidence. No live race or
restart durability test was run.

### Claude cancellation markers in 2.1.273

The installed binary fingerprint and marker offsets are in the static probe
output. They outrank an old adapter comment but do **not** establish the
request shape, authorization, selected transport exposure, bulk versus
single-item scope, or that accepted steering can still be withdrawn. Do not
mark Claude's native cancellation unsupported on the present evidence.

A separate local Claude source checkout (`6a2590911df240ff5ea56aa355696cfb94d128cb`,
not asserted to match installed 2.1.273) has
`src/cli/structuredIO.ts::injectControlResponse`, which emits
`control_cancel_request` to cancel an SDK consumer's pending permission
callback when another permission response wins. That is **not** proof of
withdrawing a user message.

Subsequent protocol controls confirmed when Claude accepts bulk
`cancel_queued`. OAR's later-turn queue is held separately in the shared
stream-json driver. [Interrupted input](claude.md#interrupted-input),
[driver](../../packages/oar/src/shared/stream-json/session.ts).

### Grok: distinguish the vendor queue from OAR's queue

Installed binary strings include `x.ai/queue/remove` and `x.ai/queue/clear`
next to serialization/notification diagnostics, plus `target_prompt_id` and
`removedFromQueue`. These are leads in the shipped client, **not** a confirmed
RPC response schema; notification send success is not a deletion receipt. A
target ID must come from native queue snapshots, never from OAR request IDs.

OAR's steer is `_x.ai/interject`, which Grok buffers until the running
turn's next safe point; `session/cancel` clears the buffer, but no native
operation withdraws one interjection, and Grok reports neither the drain nor
the clear per input ([grok](grok.md#prompting-steering-queuing-and-cancellation)). Native queue extensions need
isolated wire validation before being exposed.

### Kimi: use the installed TypeScript harness, not the Python project

The installed Node SEA binary contains readable bundled source. The static probe
records its hash and offsets for `async cancel(params)`, `acpSession.cancel()`,
`this.agent.cancel({ turnId })` and `driver.cancelRequested = true`.

In the embedded `packages/acp-server/src/session.ts`, cancellation targets the
current prompt driver; when the turn ID is not yet known it records a pending
cancel and forwards it when the launch resolves. The ACP server routes
`session/cancel` by session ID. This is active-turn cancellation, not
per-queued-message deletion. Broader KAP/klient features need their own
mapping. The local **Python kimi-cli** source is **not evidence for Kimi Code
0.42.0**.

### Pi: bulk clearing is real; per-item withdrawal is not established

Installed SDK `dist/core/agent-session.js`:

- `clearQueue()` copies and empties `_steeringMessages` and `_followUpMessages`,
  invokes `agent.clearAllQueues()`, emits a queue update and returns
  `{steering, followUp}` with the removed text entries.
- `abort()` calls `abortRetry()`, `agent.abort()` and waits for idle; it does not
  call `clearQueue()`.
- Getters return pending message text without a stable per-item cancellation
  ID. Duplicate text is possible, so text is not a safe identity scheme.
- Agent-core has its own bulk clearing methods. Calling only the lower-level
  core method bypasses AgentSession's display bookkeeping; prefer the
  high-level method when using AgentSession.

The checked-in Pi probe runs these **installed methods** against an in-memory
mock receiver. It verifies bulk clearing, returned duplicate entries and that
`abort()` makes no direct queue-clear call. It does not simulate a streaming
model or prove race ordering after a message is consumed.

OAR Pi keeps a separate `held` array on purpose: native `followUp` may continue
the same agent run, while OAR queue promises a later turn. OAR abort does not
empty `held`, and settlement can drain it. Pi SDK `clearQueue()` alone cannot
implement cancellation of OAR `queue()`.

## Consequences for OAR and Rao

1. **Keep input identity separate from operation identity.** One submission can
   produce a rejected steer followed by an accepted queue attempt. Host input
   ID (`inputId`, see [conversation.md](../spec/conversation.md)), OAR request
   IDs and native queue IDs stay separate. No text-based deduplication and no
   claim that an accepted input was consumed.
2. **Cancellation is a new operation targeting earlier input.** Keep the
   original request and response in the record stream. Record a cancellation
   attempt and its observed result; do not erase history or relabel the
   original acceptance.
3. **Separate three actions:** withdraw a not-yet-sent host input, remove
   pending input from the actual queue owner, and interrupt a running turn. A
   UI may combine them only when it can report each outcome separately.
4. **No single boolean `cancel: true`.** At minimum distinguish turn abort,
   per-item removal and bulk clearing, their owner, target type and
   confirmation strength. The table is insufficient to standardize a per-steer
   cancel API.
5. **Adapter-held queues are implementation opportunities, not native support.**
   Identity-bearing entries permit removal before dispatch, with a recorded
   result. That is an implementation decision and must not be presented as
   vendor capability. Every adapter-held queue stores the `inputId`, and
   `withdraw` records the attempt and its result; no runtime page presents
   it as native.
6. **Unknown stays unknown.** A transport timeout, a queue item that
   disappeared, or a notification without a receipt must not become
   "cancelled". Once delivery began, abort cannot promise that the input was
   unseen or its side effects undone.
7. **A chat view needs complete records.** `events()` omits steer/queue
   requests and acceptances; a cancellation view builds on records, as the
   [conversation reducer](../spec/conversation.md) does. A new subscription
   name would not restore information a projection omitted.

## Remaining validation before implementation

- Codex: isolated scripted-model run holding one active turn; add two queued
  submissions; delete one, repeat delete, race dispatch, interrupt and restart.
  Verify native IDs and notifications; never use a user's existing thread.
- Claude's subsequent [native controls](claude.md#interrupted-input)
  established the bulk cancellation request and its admission boundary.
- Grok: isolate its resident server/session; obtain native queue IDs and validate
  remove/clear notifications, changed snapshots, edit locks and dispatch races.
  Establish whether the transport used by OAR exposes those extensions.
- Kimi: test the installed ACP driver's deferred cancel against a scripted model;
  independently inspect KAP/klient if considering transport changes. Do not infer
  per-item cancellation from session/turn cancellation.
- Pi: scripted active model turn with pending steering/follow-up; clear before
  dequeue and race dequeue; compare queue_update and message_start. Test any
  future OAR-owned queue cancellation separately from the SDK queue.
