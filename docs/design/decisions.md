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

