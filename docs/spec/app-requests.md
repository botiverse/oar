# Host-answered app requests

Status: the round-trip is implemented and exported (contracts/answer.ts,
`createAppRequestAnswers` on `@botiverse/oar/kernel`), and the in-process
mock runtime exercises it in the shared behavior suite. **No vendor adapter
opts in yet**; each runtime's native evidence and the open questions are in
[the experiment](../../experiments/app-request-answering/README.md). This
page is the contract a host and an adapter may rely on today, and the rules
a future adoption must keep.

## What this covers

A runtime→app request is a `request` record with `direction: "toApp"` and the
runtime's own id. The kinds are open (`appRequestKind`): an `approval` (may
the agent run this tool, command or file change?), a `question`, a call the
adapter serves itself (`service`), or `unknown`. Until this page, every
adapter either answered such a request automatically or recorded it and left
it open: `Session` had no way for a host to reply
([decision](../design/decisions.md#host-answered-approvals-through-the-record-stream-2026-11-24)).

This contract adds exactly one thing: a host may answer an **approval** whose
adapter hands it over, and OAR records the reply. It adds no second transport,
no callback registry and no parallel event vocabulary. The request record is
the correlation; the `answered` response is the outcome OAR observed;
`events()` reads the pair as `app_request` / `app_answered` as before.

## Capability and ownership

Two facts say whether a session hands approvals to a host:

- `SessionCapabilities.appRequests` is present, naming the `kinds` a host
  owns, the `unanswered` policy, and the default `acknowledgeTimeoutMs`.
- `Session.answer` is present. Its presence is the operation, as
  `Session.steer`'s is; `SessionCapabilityDeclaration.answer` reports it
  before open.

Both absent means nothing changed for that adapter: it answers or records
`toApp` requests by its own policy. Ownership is never split for one request.
An adapter either registers the request as waiting for the host
(`createAppRequestAnswers().request`), or answers it itself
(`autoAnswer`, or the ordinary `kernel.request` + `kernel.respond` pair). A
request the adapter answered itself is not answerable: `answer` refuses it
`already_answered`, and one it never registered is `unknown_request`.

## Correlation

`answer(requestId, decision)` takes the `toApp` request record's `id`, which
is the runtime's own request id (an ACP JSON-RPC id, claude `request_id`, a
codex server-request id). OAR never mints a second identity for the pair, and
never matches by time or order.

Request ids are native to one stream. A `SessionOptions.resume` opens a
**new** stream (seq 0) with new native request ids; an id from the earlier
stream is not pending here. Answering it refuses `unknown_request`; OAR never
replays a historical request as a live one.

## Outcomes

`AnswerOutcome` carries the request record, the recorded `answered` response
when one exists (`response`), the request's `seq`, and one of five kinds:

| kind | Meaning |
|---|---|
| `accepted` | The reply was written and recorded, and the protocol's own acknowledgment was observed within the bound. |
| `unconfirmed` | The reply was written and recorded; the protocol has no acknowledgment, the bound was `0`, or the caller's signal ended the wait, so OAR cannot claim the runtime applied it. This is the honest default. |
| `timeout` | `no_native_ack`: the reply was written and recorded, but the acknowledgment did not arrive within `timeoutMs` or the session's bound. `unanswered`: the session's policy replied because no host did; `decision` is that policy decision. |
| `aborted` | The request stopped waiting before this answer took ownership: `cancelled` (the runtime withdrew it, an `app_request_cancelled` fact), `answer_aborted` (the caller's signal was already aborted), `disposed`, `runtime_exited` or `session_released` (the stream's reachability rule). |
| `rejected` | OAR wrote nothing. `code` says why, `reason` is prose: `unknown_request`, `not_answerable`, `already_answered`, `busy`, `unsupported`, `error`. |

`accepted` is not a claim that the tool ran, that a turn continued, or that
the model attended to anything. It says one reply was taken by the runtime's
transport and its receipt was seen. The tool's own result is a separate
native fact on the stream.

### Caller bounds

`AnswerOptions.timeoutMs` and `AnswerOptions.signal` bound only the wait, never
the reply:

- An already-aborted signal is refused before anything is written (`aborted`,
  `answer_aborted`).
- An abort **after** dispatch ends the acknowledgment wait at once and reports
  `unconfirmed`: the reply stays written and recorded, and OAR makes no claim
  that the runtime applied it or that native execution stopped.
- A receipt that arrives after OAR stopped waiting changes no outcome. The
  request stays settled, so a second `answer` is `already_answered`.

### Decision vocabulary

The host supplies a runtime-independent decision, and the adapter maps it to
its protocol:

```ts
type AppRequestDecision =
  | { decision: "allow"; scope?: "once" | "always" }
  | { decision: "deny"; reason?: string };
```

`scope` is a request, not a promise: an adapter whose protocol offers no
lasting option refuses `unsupported` rather than widening `once` or narrowing
`always`. `reason` travels where the protocol carries a message and stays in
the requester record otherwise. Questions and adapter-served requests are not
covered by this decision; `answer` refuses them `not_answerable`.

### One answer per request

A second `answer` for the same request refuses `already_answered`. A
concurrent one refuses `busy` while the first is writing; the first still
settles. A refused answer writes no record and leaves the request waiting, so
a transport failure (`error`) can be retried by the host. Once a reply is
written, the request is settled even when the outcome is `unconfirmed` or
`timeout`; OAR never unwrites a reply.

## Busy, dispose, exit and release

- **Busy** is only the concurrent-answer guard above. A running turn does not
  block answering: approval requests arrive *during* a turn.
- **Dispose** settles every pending host-owned request `aborted`
  (`disposed`) and refuses later answers. It never fabricates an `answered`
  response; a request that stopped waiting stays unanswered in the stream,
  which is the honest record.
- **Exit and release** do the same with `runtime_exited` and
  `session_released`, read off the stream's own `exited` / `released`
  responses. An answer attempted after them refuses `aborted`, not `busy`.
- **Native withdrawal** (`app_request_cancelled`, e.g. claude
  `control_cancel_request`) settles the request `aborted` (`cancelled`).
  Never inferred from a turn ending; a runtime may keep a request open across
  turns.

## Unanswered requests

The session declares its policy once:

```ts
unanswered:
  | { decision: "wait" }                               // default: leave it pending
  | { afterMs: number; decision: AppRequestDecision };  // answer by policy
```

`wait` is the default because OAR must not invent a human's answer. It can
hold the runtime's turn for as long as the runtime waits, which an embedded
host that cannot present a request must not choose: `deny` with a deadline is
the safe policy. A policy answer is recorded as `answered` **without**
`by: "host"` (oar decided it) and reported to the adapter as
`kind: "timeout", code: "unanswered"`.

## Records and events

Only two things change in the stream:

- An `answered` response may carry `by: "host"` when a host supplied it
  through `Session.answer`; absence means oar's own answer (automatic or
  policy). Older records have no field, which reads the same as absence.
- `app_answered` carries the same `by` when the response had it.

Everything else is the existing `toApp` request record and `answered`
response. No new frame, event, request body or record kind exists for this
feature.

## Redaction

The request's native body is recorded under the session's existing credential
rules (docs/spec/record-stream.md, "Known session credentials"), and so is
the host's reply: an approval can quote a command, a header or a file
fragment, and `answer` must not add a second, unredacted copy. The
coordinator writes the reply through the kernel, so the same session
redactor applies. The value returned to the caller (`outcome.native`) is the
runtime-facing reply, not a record, and is not redacted for the caller who
wrote it.

## Adapter obligations

An adapter that opts in must, on native evidence:

1. stop answering the approval itself, register the request with the
   coordinator under the runtime's own id, and leave the runtime waiting;
2. write exactly the native reply its protocol defines for
   `allow`/`deny`/`scope`, and return `acknowledged` only where the protocol
   has a real receipt;
3. report a native withdrawal as `app_request_cancelled` in the frame that
   carries it, and let the adapter's own dispose/exit path end the process (no
   invented answers);
4. refuse `unsupported` for a decision it cannot express instead of
   translating it silently;
5. pass its native request body and reply through the session kernel so the
   existing credential redaction covers both.

Until each of those is proven against the vendor's own protocol, that adapter
keeps its automatic answer and does not expose `Session.answer`. The
per-runtime state of that evidence is in the
[experiment](../../experiments/app-request-answering/README.md).

## Rejected alternatives

- **A host callback / answer registry.** The stream already carries the
  request; a second channel would let a host answer a request it cannot see in
  the records, and would need its own replay and teardown rules. `answer` is
  the same shape as every other control: a recorded action read back as an
  outcome.
- **A native-reply passthrough.** Letting a host hand OAR raw protocol JSON
  would put five wire formats in every host and make OAR's record the union of
  whatever the host sent. The decision vocabulary is small on purpose;
  adapters own the native mapping.
- **Answering automatically when no host answers.** That is the old policy
  and it defeats a host's tighter approval policy. The default is `wait`, and
  a host that needs a noninteractive guarantee must choose a `deny` deadline.
