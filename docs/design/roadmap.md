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
architecture v4 decision recorded in Raft thread `#all:e1d09817`, message
`5b5e279b`, and its adapter-as-client / `oar serve` direction. The
transport-binding definition is pending; its definition is recorded in the
same thread, message `b95d8f33`. Do not restate either design here.
Preserve ordering, cursors, attribution, and native reachability; do not create
a remote-only contract. Capability declaration must be finalized before this
work is accepted; its definition is also pending from that architecture
discussion.

**Acceptance:** after capability declaration is finalized, local and remote
hosts pass the same behavior cases and define disconnect/reconnect by evidence
rather than heartbeat guesses.

## Decision gates

Before adding a public surface, record: (1) the caller decision it enables,
(2) runtime evidence that the decision is unsafe today, (3) the owning layer
and contract member, (4) the cheapest regression test and resource cost, and
(5) a sea-trial case for every new `must` or `never`. If any answer is missing,
keep the idea in this roadmap or an experiment.
