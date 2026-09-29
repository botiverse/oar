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


## Answering runtime requests (2026-09-29)

**Asked for:** a host with a person to ask (rowrow) wants the runtime's
approvals and questions routed to them and answered later, from any device.
Shipped as `SessionOptions.approvals: "ask"` and `Session.answer`
([position and gates](approvals.md), [spec](../spec/approvals.md)). The
alternatives considered and refused:

- **oar deciding what is risky** (an allowlist or risk classes in oar): the
  runtime's own gate already classifies, and a second classifier would
  disagree with what the runtime then runs. The host owns who answers;
  a host wanting a policy answers requests automatically.
- **Recording only the `answered` response**, without an `answer` control
  request: a refused answer (unknown, already answered, withdrawn) would
  have nowhere honest to go, and the host's decision would be lost beside
  the native reply.
- **Voiding pending requests at the turn's end**: codex reports the
  withdrawal of an interrupted turn's request after `turn/completed`
  ([env] 0.155.1), and work outside a turn can ask; only the runtime's word
  or the exit settles a request.
- **Grok ask mode on its per-process and per-session switches**: under a
  user's `permission_mode = "always-approve"`, `grok --permission-mode
  default agent`, `_meta.yoloMode: false` and `GROK_DEFAULT_PERMISSION_MODE`
  each left a gated command running unasked (grok 1.0.44, live), and grok
  reports no mode in effect. Declared `not_enforceable`.

**What would reopen it:** a grok switch that outranks its config or a
report of the mode in effect (grok); a runtime whose gate cannot wait for a
late answer (none observed: claude took one 300 s later, codex one 20 s
later).
