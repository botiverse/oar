# Design roadmap

This plan follows [system.md](system.md). It is a sequence of evidence-backed
increments, not a promise to add every feature listed.

## Shipped foundation

- Provider-independent runtime registry with installation, model, usage, and
  session entry points.
- One lossless, attributed, resumable record stream with explicit controls.
- Runtime-specific capability declarations (partial and deliberately limited
  today), native payload reachability, read-backs, and typed unsupported
  outcomes.
- Mock, aimock, vendor, experiment, and live validation layers, with voyage
  logs as durable evidence.
- Linked design, specification, runtime, and development documentation.

## Next increments, in dependency order

### 1. Make orientation cheap

Compose the existing installation, model, account, and runtime probes into a
compact machine-readable snapshot for a host to answer “what can I do here?”
without opening a session. Do not add a second discovery mechanism. Keep
source, timestamp, and failure state explicit.

**Acceptance:** one bounded read can choose a runtime or explain why none is
usable; secrets are absent; stale and partial facts remain distinguishable.

### 2. Make actions self-describing

Give controls and unsupported outcomes stable reason categories and
retry/ownership meaning while preserving native errors. Add fields only when a
caller decision requires them.

**Acceptance:** a caller can choose retry, queue, hand off, or stop without
parsing prose; rejected input is provably caller-owned.

### 3. Make continuation first-class

If a consumer needs a handoff, define only a provider-independent shape for
runtime identity, model, cursor, graph, capability decision, and next action;
storage and lifecycle remain wholly host-owned.

**Acceptance:** a new worker can resume or reject a handoff from the artifact
alone and explain every irrecoverable gap.

### 4. Make evidence economical

Add bounded replay and projection helpers only for measured needs. Prefer
incremental folds and cursors to rescanning unbounded logs; keep voyage format
versioned and forward-compatible.

**Acceptance:** live reconnect and offline replay produce equivalent
projections without duplicate controls.

### 5. Extend control across placement

Only when a real host needs remote or multi-client operation, follow the
architecture decision recorded in Raft thread `#all:e1d09817`, message
`5b5e279b` (architecture v4): remote placement is `oar serve` on the agent host
with a thin application-side client, and adapter-as-client is limited to
managed cloud runtimes. Two supporting design pages are pending and have no
draft yet, the transport binding and the capability declaration. Both
originate in message `b95d8f33` of the same thread, and the capability
declaration still needs owner endorsement. Preserve ordering, cursors,
attribution, and native reachability; do not create a remote-only contract.

**Acceptance:** local and remote hosts pass the same behavior cases and define
disconnect/reconnect by evidence rather than heartbeat guesses. Remote clients
choose actions from the capability declaration, so this item lands after that
page is settled.

## Decision gates

Before adding a public surface, record: (1) the caller decision it enables,
(2) runtime evidence that the decision is unsafe today, (3) the owning layer
and contract member, (4) the cheapest regression test and resource cost, and
(5) a sea-trial case for every new `must` or `never`. If any answer is missing,
keep the idea in this roadmap or an experiment.

## Decided against

Positions that were considered and refused, with the reasons, so the next
host author finds the answer here instead of re-deriving it. A refusal is
re-opened by evidence, not by preference; each entry names what would.

### Session history readback (2026-09-15)

**Asked for:** a provider-independent way to read a stored session back
through oar (`readSession(id)` returning the transcript) so a host can show
what happened before it resumes. Every runtime has the native means:
codex `thread/read` and the `turns` of a `thread/resume` reply, claude's
transcript jsonl, pi's `SessionManager` history tree, ACP `session/load`.

**Refused, primarily because stored state and the live wire are not
isomorphic.** Codex persists `turns[].items[]`, not the `item/*`,
`turn/*`, `rawResponseItem/*` notifications the adapter projects; claude's
transcript carries the message shapes but no `result` frames, so no turn
end and no usage; pi's history entries (messages, compaction, branches) are
not `AgentSessionEvent`s at all. Only ACP `session/load` replays history in
the live shape. A readback therefore needs a second projection per runtime,
and its output cannot honestly be a `Frame` (the runtime never said it on
the wire). The two honest shapes both cost more than they return: a
separate `HistoryEntry` vocabulary makes every host maintain a second fold,
and projecting stored state to `Event` forces the spec to redefine
`turn_started`, which is read from the prompt request record, not from a
runtime fact. Either way the cost lands in every adapter and in the spec.
See [codex](../runtimes/codex.md#observation-children-and-history),
[claude](../runtimes/claude.md#session-creation-and-resume),
[pi](../runtimes/pi.md#observation-history-and-children).

**And because the value is small.** A host that runs a session is already
subscribed to it, so it holds every `Event` it ever rendered. Persisting
that flat stream rebuilds the transcript exactly and follows the host's own
fold when the fold changes; the runtime's native resume
(`SessionOptions.resume`) gives the agent its memory. Every workspace in
[prior-arts](../prior-arts/README.md) persists its own unified events and
none reads native history back: Paseo's timeline items, Lody's session
document, Synara's canonical journal, One Works' per-session `RuntimeEvent`
JSONL, Orca's wire history; Herdr and Multica keep only the native id and
re-run the native resume. The host contract is therefore: persist
`Session.events()` (or a voyage log when the native frames matter), keep
`runtime` plus `Session.id`, resume natively.

**Not decided here:** listing a runtime's stored session ids without their
contents is a smaller, separate question and stays open.

**What would reopen it:** a host whose sessions are created outside it (by
the vendor CLI directly) and that must render them, or a runtime landscape
where stored history and the wire share one shape. Then the choice is
between the `HistoryEntry` vocabulary and the `Event` projection with a
readback-aware `turn_started`, and it goes through the decision gates above.

