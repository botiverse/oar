# Design decisions

Positions that were considered and refused, with the reasons, so the next
host author finds the answer here instead of re-deriving it. A refusal is
re-opened by evidence, not by preference; each entry names what would.

## Decision gates

Before adding a public surface, record: (1) the caller decision it enables,
(2) runtime evidence that the decision is unsafe today, (3) the owning layer
and contract member, (4) the cheapest regression test and resource cost, and
(5) a sea-trial case for every new `must` or `never`. If any answer is missing,
keep the idea in the [roadmap](roadmap.md) or an experiment.

## Control objects as the event model (2026-09-03)

**Considered:** the first event model (v1), in which control objects carry
the facts: `begin()` and `settle()` fan out the turn events, and a fact
reaches consumers only while its control object is open.

**Refused, because it loses facts in five ways:**

- **Synthesized turn boundaries**: if `begin()` / `settle()` fan out
  `turn_started` / `turn_ended` themselves, the skeleton of the stream comes
  from "our API was called", not from the runtime.
- **A closed control plane swallows facts**: an `if (!isSettled) fanOut(...)`
  gate silently drops runtime events arriving after settlement.
- **A mandatory `turnId` loses facts without a turn**: pi's session-level
  events (compaction, queue, retry) belong to no turn and would have
  nowhere to go.
- **One answer split across two paths**: a turn outcome half in a promise
  and half in an event, or a steer half in a return value and half in the
  stream, forces every consumer to join the two. kimi-cli leaks the turn
  outcome into `_handle_prompt`'s return value, while the `TurnEnd`
  docstring admits it "may be omitted" when interrupted.
  [src: kimi-cli wire/server.py:644-755; wire/types.py]
- **Query masquerade**: a `contextUsage()` that caches the latest usage seen
  carries no seq, so it can neither be aligned with other records nor
  replayed.

Control and facts are therefore records on one stream, and control never
decides whether a fact exists ([record stream](../spec/record-stream.md)).

**What would reopen it:** a control-object model shown to keep every fact
in all five cases.

## Separate channels for control and facts (2026-09-03)

**Considered:** fixing the control-object model by giving control and facts
a channel each.

**Refused, because every shipped runtime carries both on one channel:**

- kimi-cli's message algebra is one union whose discriminator is "does it
  expect a reply": `type WireMessage = Event | Request`, the `Request`
  docstring verbatim "a message that expects a response". On the wire only
  the shape differs (a request has an id); one `_write_queue` and one
  `wire.jsonl` hold everything.
  [src: kimi-cli@cbc15c0 wire/types.py; wire/jsonrpc.py:49-56,174-204;
  wire/server.py; wire/file.py]
  KLIP-12 lists "no new transport channel" as a non-goal.
  [doc: klip-12, Implemented]
- codex: `OutgoingMessage` carries notification / request / response on
  one connection. [src: codex-rs/app-server/src/outgoing_message.rs:1-80]
- kimi-cli routes sub-agent records **by obligation** (request-class records
  passed through verbatim, the rest wrapped as `SubagentEvent`) on the same
  channel and send: the split is by obligation, not by channel.
  [src: subagents/runner.py:393-428]

**And because total order is what channel splitting cannot buy back:** two
paths share no seq, so "did the abort land before or after that
tool_result" becomes permanently unanswerable. A transport stream per
sub-agent loses it the same way, so attribution is a field on the record
([attribution](../spec/attribution.md)).

**What would reopen it:** a consumer that two channels serve and one ordered
stream cannot, together with a way to keep one total order across them.

## Concurrent control planes and prompts (2026-09-03)

**Considered:** concurrent control planes, and concurrent prompt queueing:
a session taking a new prompt while a turn runs.

**Refused, because no shipped runtime needs them:** kimi-cli returns
`INVALID_STATE` with a TODO in the source, pi has no such form, claude and
codex do not expose the semantics. [src: kimi-cli wire/server.py:644-755]
A session has one control plane and at most one active turn: a prompt
while a turn runs is rejected `busy`, never queued implicitly, and input for
a later turn is the explicit `queue`
([record stream](../spec/record-stream.md#record-contracts)).

**What would reopen it:** a runtime that defines concurrent prompts
natively, and a host that needs them.

## A storage layer (2026-09-03)

**Considered:** oar persisting the records it retains, so a stream can be
replayed after the adapter process dies.

**Refused, because applications own their data layer**
([replay boundary](foundations.md#replay-boundary)): a host persists the
records beside its own product data, indexes and retention policy, and
replays them through the same projections. The kernel retains records in
memory for the adapter process's lifetime. A rebuild from the runtime's
native history was refused separately
([session history readback](#session-history-readback-2026-09-15)).

**What would reopen it:** oar running as a service that outlives the hosts
it serves ([placement](hard-problems.md#beyond-a-single-local-process)), so
that no host process is there to hold the log.

## A usage basis label (2026-09-03)

**Considered:** a usage `origin` or accounting-basis label on usage records
(per-turn or cumulative, which of a runtime's overlapping views), so a
consumer can reconstruct how a number was counted.

**Refused, because applications need correct, usable numbers, not a
reconstruction of provenance.** Which runtime view is authoritative and how
to deduplicate stay inside each adapter
([usage](../spec/attribution.md#usage-one-constraint)). Both ACP usage RFDs
are still Draft with open items verbatim including "Ambiguous totals",
"Per-turn vs cumulative", "Cost separation", so a basis label would hand
consumers an unsettled problem.
[acp, pinned clone bb2ef8f7: session-usage.mdx; end-turn-token-usage.mdx:26,97,101]

**What would reopen it:** ACP settling those items, or a consumer whose
decision needs the basis and not only the number.

## A per-agent cursor filter (2026-09-03)

**Considered:** a cursor that resumes one sub-agent's records only (a
`streamId` filter on `Cursor`).

**Refused, because no consumer has demonstrated "resume just one
sub-agent".** For a single-agent view, resume the whole stream and filter
client-side by `agentPath`
([cursor](../spec/session-graph-and-cursor.md#the-resumable-cursor)).

**What would reopen it:** a consumer that must resume one sub-agent and
cannot read the whole stream to do it.

## Session history readback (2026-09-15)

**Asked for:** a provider-independent way to read a stored session back
through oar (`readSession(id)` returning the transcript) so a host can show
what happened before it resumes. The native history and live-stream
differences are documented under
[codex](../runtimes/codex.md#observation-children-and-history),
[claude](../runtimes/claude.md#session-creation-and-resume), and
[pi](../runtimes/pi.md#observation-history-and-children).

**Refused, primarily because stored state and the live wire are not
isomorphic.** A readback therefore needs a second projection per runtime,
and its output cannot honestly be a `Frame` (the runtime never said it on
the wire). The two honest shapes both cost more than they return: a
separate `HistoryEntry` vocabulary makes every host maintain a second fold,
and projecting stored state to `Event` forces the spec to redefine
`turn_started`, which is read from the prompt request record, not from a
runtime fact. Either way the cost lands in every adapter and in the spec.

**And because the value is small.** A host that runs a session is already
subscribed to it, so it holds every `Event` it ever rendered. Persisting
that flat stream rebuilds the transcript exactly and follows the host's own
fold when the fold changes; the runtime's native resume
(`SessionOptions.resume`) gives the agent its memory.
The [session persistence comparison](../prior-arts/feature-comparison.md#会话历史与恢复)
records host-owned transcripts alongside native history access and resume.
Paseo also exposes history reading, so the comparison supports separating
these responsibilities; it does not establish that hosts never need native
history readback. The host
contract is therefore: persist
`Session.events()` (or a voyage log when the native frames matter), keep
`runtime` plus `Session.id`, resume natively.

**Not decided here:** listing a runtime's stored session ids without their
contents is a smaller, separate question and stays open.

**What would reopen it:** a host whose sessions are created outside it (by
the vendor CLI directly) and that must render them, or a runtime landscape
where stored history and the wire share one shape. Then the choice is
between the `HistoryEntry` vocabulary and the `Event` projection with a
readback-aware `turn_started`, and it goes through the decision gates above.


## Recording claude's effort read-back (2026-09-29)

**Asked for:** `SessionOptions.effort` promises that a requested level is
never dropped silently, and `Session.effort()` reads the runtime's own
report. claude 2.1.284 reports the level it will send in one place only:
the `get_settings` control request, whose `applied.effort` is "what will
actually be sent to the API" after env overrides, settings clamps and model
defaults ([claude runtime page](../runtimes/claude.md#models-instructions-and-context)).
The claude adapter asks it at open when an effort is requested and refuses
the open on anything else. Every other stdout line becomes a frame, so the
question was whether this answer should too, giving `effort()` a value on
claude.

**Refused, because the answer is not only the effort.** `get_settings`
takes no parameters, and it answers with the merged settings of every
source (`effective`, `sources`: hooks, permissions, any `env` block)
around `applied`. Recording it verbatim, and `native` is never trimmed,
would copy a user's settings, secrets in an `env` block included, into
every consumer's log: oar itself asked for them, and the runtime would not
have volunteered them in the session. The answer is consumed like codex's
`initialize` reply: adapter plumbing, not the session's words. A
successful open is the confirmation that claude runs the requested level;
`effort()` stays null on claude and the contract comment says so.

**What would reopen it:** claude reporting the effective effort in its
stream (`system/init` or the `assistant` frame; the transcript file already
records `effort` per assistant message, but oar never reads transcripts),
or a `get_settings` that can be narrowed to `applied`.
