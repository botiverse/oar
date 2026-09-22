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

**Landed for controls (2026-09-23):** a rejected control response carries one
typed `code` beside the prose `reason` (`busy`, `no_active_turn`,
`unsupported`, `runtime_exited`, `disposed`, `runtime_refused`, `error`),
and the `Session` a consumer holds answers `prompt / steer / queue / abort`
with the records read (`ControlOutcome`: `accepted | rejected`, `code`,
`seq`, the records underneath). The caller decision that forced it: the
arena app (`apps/arena/fighters.ts`) matched `reason === "busy"` by string
and polled `prompt()` every 500 ms to wait a spontaneous turn out. The
proactive half is `Session.status()` (the `reduceStatus` fold, promoted to a
query with the invariant that `busy` is rejected exactly while it says
`running`) with `awaitIdle`, and `promptAndWait` takes `timeoutMs` /
`signal` so the timeout-then-abort-then-await-the-runtime's-own-outcome
sequence is written once. Spec: [record-stream.md](../spec/record-stream.md)
"Further rules"; regression: `tests/turns.test.ts`; sea-trial:
`session.single-active-turn`. Unsupported *inventory* outcomes already carry
codes; the remaining open part is the runtime's own failure prose in
`TurnOutcome.failed` (`FailureClass` is the category today).

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

Public additions must pass the [design decision gates](decisions.md#decision-gates).
Keep ideas that lack evidence here or in an experiment.
