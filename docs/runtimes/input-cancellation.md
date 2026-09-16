# Steer, queue and cancellation

Local investigation, **2026-09-16**, OAR baseline **3582a52**. This is an evidence
report and design input, not a shipped cancellation capability. No authenticated
turns, logins or model requests were run. Native behavior not exercised is marked
explicitly; lack of a match in a binary is never proof of absence.

## Findings

| Runtime / examined version | Steer withdrawal | Queue withdrawal | Current OAR behavior |
|---|---|---|---|
| Codex CLI 0.154.0 | No per-steer deletion endpoint established; `turn/steer` returns a turn ID, not a cancellable input handle | **Native per-item deletion**, experimental `thread/queue/delete({threadId, queuedSubmissionId}) → {deleted}`; verified in installed schema and local source, not a live model turn | Native durable queue; add response retains the native submission in `response.body.native`. Delete/list are not exposed by Session |
| Claude Code 2.1.273 | **Unverified**: installed binary contains `cancel_queued`, `cancelQueued`, `interrupt_cancel_queued_v1`, `interrupt_receipt_v1`, `msg_lifecycle_v1` | Same native leads; scope, parameter shape, capability negotiation and receipts need protocol validation | Steer writes a user message to stdin; OAR's later-turn queue is a separate in-memory array; abort sends an interrupt control request |
| Grok Build 1.0.30 (04b7ffed98c6) | OAR steer is a `session/prompt` with `sendNow`; withdrawal after delivery is **unverified** | **Native extension leads** in installed binary: `x.ai/queue/remove`, `clear`, `edit`, `hold_edit`, `release_edit`, `reorder`; not yet verified on a wire session | OAR uses a separate ACP adapter-held queue; those vendor queue operations do not automatically cancel OAR's held entries |
| Kimi Code 0.42.0 (TypeScript harness) | Selected ACP interface has no mapped steer; no per-input withdrawal established | No per-item withdrawal established on selected ACP interface; do not generalize to every native KAP/SDK surface | ACP queue is OAR-held; `session/cancel` routes to the active agent turn, including deferred cancellation while its turn ID is pending |
| Pi SDK 0.84.2 (OAR dependency) | **Native bulk clearing** of pending steering and follow-up messages via `AgentSession.clearQueue()`; no public per-item handle established | SDK clear applies to SDK queues; OAR's later-turn queue is a different array | Steer enters Pi's queue; OAR queue is adapter-held. `abort()` and `clearQueue()` are separate. Installed SDK methods exercised with a mock receiver |

`queue: { durable: false }` says nothing about cancellation. OAR currently has
`abort()`, but no `cancel(requestId)`, `removeQueuedInput()` or `clearQueue()`
public Session operation. The report does not propose advertising native
features until an adapter actually maps and verifies them.

## Evidence and limits by runtime

### Codex: strongest per-item native contract

Installed `codex app-server generate-json-schema --experimental` emits:

- `ThreadQueueDeleteParams`: required `threadId`, `queuedSubmissionId`.
- `ThreadQueueDeleteResponse`: required boolean `deleted`.
- `ThreadQueueAddResponse`: `queuedSubmission` (preserve its ID).
- `TurnSteerResponse`: `turnId`; `TurnInterruptParams`: `threadId`, `turnId`.

Without `--experimental`, queue method schemas are absent; omission from the
stable schema must not be reported as lack of native support.

Local Codex source at `4f39251a010a8bd7d692d25fb33832ff06f1635a`:

- `codex-rs/app-server-protocol/src/protocol/common.rs`: experimental queue methods.
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs`: delete request/result.
- `codex-rs/app-server/src/request_processors/thread_queue_processor.rs`: delete
  delegates to the queue service and returns its boolean.
- `codex-rs/ext/queue/src/service.rs`: deletion and dispatch share a per-thread
  dispatch guard. A started submission is removed from the queue. Therefore
  `deleted: false` cannot alone distinguish already dispatched from nonexistent
  or previously deleted; it must not be reported as successful withdrawal.
- The same service's `on_thread_idle` returns early for
  `ThreadIdleCause::Interrupted`. Source evidence indicates interrupt pauses
  automatic draining on that edge, rather than clearing stored queued inputs.

Installed schema and source snapshot are separate evidence. No live race or
restart durability test was run in this investigation.

### Claude: new cancellation markers require verification

The installed binary fingerprint and marker offsets are retained in the static
probe output. They are stronger evidence than an old adapter comment, but do
**not** establish the request shape, authorization, selected transport exposure,
bulk versus single-item scope, or that accepted steering can still be withdrawn.
Do not mark Claude's native cancellation unsupported on the present evidence.

A separate local Claude source checkout (`6a2590911df240ff5ea56aa355696cfb94d128cb`)
has `src/cli/structuredIO.ts::injectControlResponse`: it emits
`control_cancel_request` to cancel an SDK consumer's pending permission callback
when another permission response wins. That is **not** proof of withdrawing a
user message. This checkout is not asserted to match installed 2.1.273.

OAR's `runtimes/claude/session.ts` stores held input in `heldQueue: string[]`.
Its interrupt path does not clear that array; its turn-end handler can dispatch
the next entry. Native `cancel_queued`, if later verified, would not by itself
clear this OAR-owned queue. The adapter comment claiming a native later-turn
queue is impossible is a mapping assumption, not a current native capability
survey; reassess it before designing a new API.

### Grok: distinguish the vendor queue from OAR's queue

Installed binary string evidence includes literal `x.ai/queue/remove` and
`x.ai/queue/clear` next to serialization/notification diagnostic messages, plus
`target_prompt_id` and `removedFromQueue`. This establishes leads in the shipped
client, **not** a confirmed RPC response schema. In particular, notification
send success is not a confirmed deletion receipt. A target ID must be established
from native queue snapshots; do not guess it from OAR request IDs.

OAR's Grok profile steers with `_meta: {sendNow: true}` and uses the shared ACP
adapter's held queue for `queue()`. The former can interrupt/restart work; it
is not evidence that an already delivered input is retractable. Native queue
extensions require isolated wire validation before being exposed.

### Kimi: use the installed TypeScript harness, not the Python project

The installed Node SEA binary contains readable bundled source. The static probe
records its hash and offsets for `async cancel(params)`, `acpSession.cancel()`,
`this.agent.cancel({ turnId })` and `driver.cancelRequested = true`.

In the embedded `packages/acp-server/src/session.ts` module, cancellation targets
the current prompt driver. When the turn ID is not known yet it records a pending
cancel and forwards cancellation again when the launch resolves. The ACP server
routes `session/cancel` by session ID. This is active-turn cancellation, not
per-queued-message deletion. OAR `kimiAcpProfile` has `steer: false` and uses the
shared in-memory ACP queue. Broader KAP/klient features need their own mapping.

The separately installed/local **Python kimi-cli** source was inspected during
reconnaissance but is deliberately **not evidence for Kimi Code 0.42.0**.

### Pi: bulk clearing is real; per-item withdrawal is not established

Installed SDK `dist/core/agent-session.js`:

- `clearQueue()` copies and empties `_steeringMessages` and `_followUpMessages`,
  invokes `agent.clearAllQueues()`, emits a queue update and returns
  `{steering, followUp}` containing removed text entries.
- `abort()` calls `abortRetry()`, `agent.abort()` and waits for idle; it does not
  call `clearQueue()`.
- Getters return pending message text, without a stable per-item cancellation ID.
  Duplicate text is possible; comparing text is not a safe identity scheme.
- Agent-core has separate bulk clearing methods too. Calling only the lower-level
  core method would bypass AgentSession's display bookkeeping; prefer the
  high-level method when using AgentSession.

The checked-in Pi probe runs these **installed methods** against an in-memory
mock receiver. It verifies bulk clearing, returned duplicate entries and the
absence of a direct queue-clear call in `abort()`. It does not simulate an actual
streaming model or prove race ordering after a message is consumed.

OAR Pi intentionally keeps a separate `held: string[]`: native `followUp` may
continue the same agent run, while OAR queue promises a later turn. OAR abort does
not remove that held array; settlement can drain it. Pi SDK `clearQueue()` alone
therefore cannot implement cancellation of OAR `queue()`.

## Consequences for OAR and Rao

1. **Keep input identity separate from operation identity.** One user submission
   can produce a rejected steer attempt followed by an accepted queue attempt.
   Preserve a host submission ID, OAR request IDs, and native queue IDs separately.
   No text-based deduplication and no claim that an accepted input was consumed.
2. **Cancellation is a new operation targeting earlier input.** Keep the original
   request and response in the record stream. Record a cancellation attempt and
   its observed result; do not erase history or relabel the original acceptance.
3. **Separate three actions:** withdraw a not-yet-sent host input, remove pending
   input from the actual queue owner, and interrupt a running turn. A UI may
   combine them only when it can report each outcome separately.
4. **Do not add one boolean `cancel: true`.** At minimum distinguish turn abort,
   per-item removal and bulk clearing, their owner, target type and confirmation
   strength. The table is insufficient to standardize a per-steer cancel API.
5. **Adapter-held queues are implementation opportunities, not native support.**
   Replacing string arrays with identity-bearing entries could permit removal
   before dispatch, with a recorded result. That is a separate implementation
   decision and must not be sold as vendor capability.
6. **Unknown stays unknown.** A transport timeout, a queue item that disappeared,
   or a notification without a receipt must not become “cancelled”. Once delivery
   began, abort cannot promise that the input was unseen or its side effects undone.
7. **A chat view needs complete records.** Requests, responses and native frames
   can drive one replayable view. `events()` remains a convenient projection; it
   currently omits steer/queue requests and most acceptance responses. A new
   subscription name would not restore information already omitted by projection.

## Remaining validation before implementation

- Codex: isolated scripted-model run holding one active turn; add two queued
  submissions; delete one, repeat delete, race dispatch, interrupt and restart.
  Verify native IDs and notifications; never use a user's existing thread.
- Claude: negotiate the installed message-lifecycle/interrupt capabilities in an
  isolated mock-provider process; establish `cancel_queued` request shape and
  receipts, which messages it targets, and behavior after dequeue. Binary markers
  alone do not authorize a support claim.
- Grok: isolate its resident server/session; obtain native queue IDs and validate
  remove/clear notifications, changed snapshots, edit locks and dispatch races.
  Establish whether the transport used by OAR exposes those extensions.
- Kimi: test the installed ACP driver's deferred cancel against a scripted model;
  independently inspect KAP/klient if considering transport changes. Do not infer
  per-item cancellation from session/turn cancellation.
- Pi: scripted active model turn with pending steering/follow-up; clear before
  dequeue and race dequeue; compare queue_update and message_start. Separately
  test any future OAR-owned queue cancellation rather than mixing the two queues.

Reproduction and sanitized observations: [experiments/cancellation](../../experiments/cancellation/README.md).
