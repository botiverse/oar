# Coxswain roadmap

Where the cockpit is headed. Coxswain is oar's **live verification
instrument** —
the place where dogfooding and contract verification become the same
activity. It is the standing backlog for coxswain development.

## Why coxswain exists, restated as two loads

1. **Dogfooding**: every public oar surface should be exercised by a real
   human, in a real UI, on real runtimes, routinely — not only by the test
   suite. The library's ergonomics are only proven by a consumer that is
   not the library's own tests.
2. **Verification**: everything that happens in the cockpit flows through
   the public contract, so the cockpit is a place where contract violations
   can be *caught in the wild* — on sessions and prompts no test author
   thought to write.

Every roadmap feature must carry both loads. A feature that only makes the
UI nicer, or only checks something the sea-trial suite already checks the
same way, does not belong here.

## Principles

- **Public surface only.** Coxswain consumes `@botiverse/oar` exactly like
  an external consumer: the registry, the Session API, the observe layer.
  It never imports runtime internals. If the cockpit cannot build a feature
  on the public surface, that is a library gap — file it against oar and
  build the feature when the surface exists, rather than working around it.
- **An anomaly becomes a test.** The distance from "that looked wrong in
  the cockpit" to "failing test case in the repo" should be one action, not
  an afternoon of reconstruction.
- **The smoke stays honest.** Every new view gets deterministic fixtures
  and lands in the screenshot smoke (`xvfb-run -a pnpm --filter
  @botiverse/coxswain smoke`), so the whole cockpit remains verifiable
  without a login.
- **Work the repo's gate.** Everything here follows
  [`docs/development.md`](../../docs/development.md): cheapest test kind
  that can catch the mistake, `pnpm run check` green before every commit.

## The features

### Foundations landed (Milestone 1)

The host and capture foundation is now implemented and documented in the
[README](README.md): concurrent session lanes with stable identities,
lane-tagged global/per-lane event fan-out, lane-targeted lifecycle operations,
and per-lane `oar-voyage/1` capture. The renderer's existing one-lane launch
flow remains as a compatibility consumer while the fleet API is exercised by
the next UI slices.

### 1. Regatta — one prompt, every runtime, side by side

Run the same prompt simultaneously against several runtimes (claude, codex,
pi, …) in one window, each lane with its own conversation, Friendly/Raw
activity, and status lamp; lanes are individually steerable and abortable.

- **Dogfoods**: the registry across all built-ins, concurrent independent
  sessions in one process, per-session observers.
- **Verifies**: cross-runtime contract uniformity on *arbitrary human
  prompts* — the interactive counterpart of running one sea-trial case on
  every backend. Divergence you can see (one lane's timeline missing a
  phase another lane has) is a contract finding.
- **First slice**: two fixed lanes, prompt broadcast, no per-lane steering.

### 2. Contract lens — live invariant checking on the event stream

A checker subscribed to each session's raw event stream that continuously
asserts the stream-level invariants the spec promises (event ordering,
turn attribution, terminal-outcome consistency, cursor monotonicity as the
v2 record-stream contract lands — see [`docs/spec/`](../../docs/spec/README.md)).
Violations surface as a first-class alarm row in Activity, not a console
warning.

- **Dogfoods**: the event stream as a machine-checkable artifact; the
  observe-layer discipline (consumer-side derivation over public events).
- **Verifies**: the invariants themselves, on live traffic. The sea-trial
  suite checks them on scripted scenarios; the lens checks them on
  everything anyone ever does in the cockpit.
- **First slice**: three invariants (a turn ends exactly once; no events
  attributed to a turn after its `turn_ended`; monotonic `receivedAt`
  within a turn), alarm row in Raw view.

### 3. Voyage recorder — record, replay, export as a test

Persist the complete raw event stream of a session (with submissions and
timings) as a *voyage log* on disk. Any voyage can be replayed into the
cockpit deterministically, and exported as the skeleton of a sea-trial
case or vendor test: the anomaly-to-test path made real.

- **Dogfoods**: the event stream's completeness — if a replayed voyage
  cannot reconstruct what the live session showed, the stream is lossy,
  which is itself a finding.
- **Verifies**: doubles the contract lens's value (violations arrive with
  their repro attached) and turns cockpit sessions into regression
  fixtures.
- **First slice**: record + replay into the existing views; export comes
  after the recorded shape has survived a few real voyages.

### 4. Session graph — see the subagent tree

When a runtime fans work out to subagents, render the session graph the
v2 spec describes (parent/child sessions, per-node status and timeline)
instead of folding everything into one flat timeline.

- **Dogfoods**: the session-graph portion of the v2 contract the moment it
  exists — a real consumer waiting on the drafted surface, keeping the
  spec honest about what a UI actually needs.
- **Verifies**: attribution — every event lands on the right node, no
  orphan nodes, no events after a node closes. Concurrent-subagent capture
  is a known open question for claude; this view is where the answer
  becomes visible.
- **First slice**: a tree panel driven from whatever parent/child signal
  the stream carries today, degrading gracefully to a single node.

### 5. Usage helm — quota as an instrument, not a snapshot

Poll `accountUsage` around turn boundaries and show usage as motion:
per-turn deltas, burn rate over the session, projected time-to-limit
against each window's reset.

- **Dogfoods**: the account-usage contract under repeated, interleaved
  reads across runtimes — well beyond the launcher's single read today.
- **Verifies**: snapshot sanity over time (ratios move monotonically
  within a window, resets actually reset, `reauth_required` surfaces
  instead of garbage) — properties only observable across many reads.
- **First slice**: usage read before/after each turn, delta shown on the
  turn's outcome row.

### 6. Drills — induced faults, promised behavior

A drill menu that deliberately breaks things — kill the runtime process
mid-turn, sever the say bridge, abort during a tool call, hold a turn past
the stall threshold — and then *asserts in the UI* that the observer and
session honored their promises (status reaches `stuck`/`error`, outcome is
a failure with the right class, dispose still completes cleanly).

- **Dogfoods**: the failure half of the contract, which polite manual
  dogfooding never touches.
- **Verifies**: the promises that matter most in production consumers and
  are hardest to trust from unit tests alone: failure classification,
  stall detection, disposal under damage.
- **First slice**: two drills (kill process, abort mid-tool-call) with a
  pass/fail verdict row; grow the drill list from real incidents.

## Build order

- **Milestone 1 — foundations** (landed): generalize the single `AgentHost`
  into a fleet host (N sessions, stable lane identity, per-lane event fan-out),
  and land the voyage recorder's capture half. The implementation and capture
  location are documented in the [README](README.md).
- **Milestone 2 — parallel tracks** (independent once M1 lands): Regatta
  view · Contract lens · Usage helm. Three lanes with no shared files
  beyond M1's host — suitable for concurrent tasks.
- **Milestone 3 — the deep end**: voyage replay + export-to-test · session
  graph (pace with the v2 spec) · drills.

Each milestone keeps the smoke green and updates this file: features move
out of the roadmap and into the README as they become real, in the same
commit that ships them.

## Non-goals

Coxswain is not becoming a general chat product, a cloud service, or a
second test runner. The `say` bridge remains an acknowledged temporary
measure; if the roadmap's features make its limits painful, the answer is
a native reply surface in oar, driven as library feedback — not a bigger
bridge in the app.
