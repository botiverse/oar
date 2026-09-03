# Specification

> **Status: DRAFT v0.8 — under review.** This is the concrete v2 design,
> kept deliberately separate from [`docs/design/`](../design/README.md):
> design records *why* (principles, evidence, what must not go wrong), this
> directory records *what* (record shapes, envelope, session graph, cursor
> semantics). Principles pages never contain wire shapes; spec pages cite
> the principles instead of restating them.

## The contract in one line

v2 is one ordered, resumable record stream. Records split into three kinds
by obligation (event / request / response), every record self-attributes
(session graph + `agentPath`), and a monotonic `seq` on the stream is the
cursor.

The external promise: everything the runtime said is in the stream, nothing
oar didn't observe is in it, every record knows whose it is, and the stream
is resumable from any position.

**Non-goals:** multiple transport channels, multiple control planes,
concurrent prompt queueing (no shipped runtime needs it — see
[record-stream.md](record-stream.md)); a storage layer; usage *derivation*
(cumulative/epoch/boundary views are consumer business).

## Pages

| Read | To answer |
|---|---|
| [record-stream.md](record-stream.md) | Why one stream with three record kinds? What exactly is an event, a request, a response? |
| [attribution.md](attribution.md) | How do records self-attribute? Why is attribution a field, not a channel? How is usage exposed? |
| [session-graph-and-cursor.md](session-graph-and-cursor.md) | What goes in the session graph, and how does resumable reading work? |
| [runtime-matrix.md](runtime-matrix.md) | How does each shipped runtime map onto the contract, and what are adapters forbidden to do? |
| [ablation.md](ablation.md) | Which elements were tried for deletion and why the survivors stayed |

All examples in these pages are illustrative: seq values and field contents
are invented; the record shapes and invariants are normative. Field names
follow the final TypeScript contracts.

## Open decisions

Three points are deliberately **not settled** in this draft; the pages flag
them where they appear:

1. **`causedBy` stays deleted?** A causal-link field between records was
   removed in v0.7 because no consumer scenario required it. The removal is
   still open to reversal in review.
2. **External compaction.** Compacting a session externally (new session +
   injected summary prompt), layered above runtime-native compaction
   ([hard problem 14](../design/hard-problems.md#beyond-a-single-local-process)),
   is designed but not yet folded into this spec.
3. **Capability declaration.** A fuller typed capability surface (adapters
   declaring what they support, beyond the attribution-tier declaration
   required in [runtime-matrix.md](runtime-matrix.md)) is a candidate for
   the next revision.

## Version lineage

v0.3 attribution dimensions established → v0.4 ACP spec evidence → v0.5
kimi-cli native-wire evidence → v0.6 ACP gap wording corrected + kimi-code
KAP evidence → v0.7 review convergence (usage compressed to one constraint,
`fact` renamed `event`, synthesized turn boundaries deleted, cursor
semantics settled, `causedBy` deleted) → v0.8 ablation pass (element-wise
deletion tests; everything without a concrete breaking scenario was cut —
see [ablation.md](ablation.md)).

## Legend

Record markers, used symbol+word so nothing depends on color:

- ✓ `event` — the runtime's own words
- ◆ `request` — an action record that expects an outcome
- ◇ `response` — always points at a request
- ○ absence — an outcome that was never observed (honest gap)

Evidence tags: `[src]` vendor source code (pinned commits where noted) ·
`[sym]` binary symbols · `[v1]` code shipped in OAR v1 · `[env]` observed
runtime behavior · `[doc]` official documentation · `[acp]` ACP
spec/schema (pinned clone bb2ef8f7).

## How to maintain these docs

These pages are a contract, and a stale contract is worse than none. The
rules that keep them in sync:

- **Same-commit rule.** When code changes what the contract says — a
  record shape, envelope field, cursor semantics, an adapter's tier — the
  spec page changes in the same commit. Never "update the docs later".
- **What changes together.** One contract change usually touches several
  places; update them as a unit: the code ↔ the owning spec page ↔ the
  affected row in [runtime-matrix.md](runtime-matrix.md) ↔ the
  [ablation.md](ablation.md) ledger (every field added or deleted gets a
  deletion-test entry — a breaking scenario if kept, a cut record if
  removed).
- **Where new material belongs.** *Why* a position holds (principles,
  evidence, failure modes) goes to [`docs/design/`](../design/README.md);
  *what* the contract is (shapes, semantics, per-runtime mapping) goes
  here. Spec pages cite design pages instead of restating them, and
  design pages never contain wire shapes.
- **Index and pointers.** Adding or removing a page means updating the
  table above and the pointer in the root `README.md` in the same commit.
- **Version discipline.** A semantic change to the contract bumps the
  draft version in the status banner and extends the version lineage
  above; flag anything deliberately unsettled under "Open decisions".
