# Specification

> **Status: SHIPPED (v1.0 of this document).** The record-stream
> contract below is what `@botiverse/oar` emits today
> (`packages/oar/src/contracts/session.ts` is the normative TypeScript).
> It is kept deliberately separate from [`docs/design/`](../design/README.md):
> design records *why* (principles, evidence, what must not go wrong), this
> directory records *what* (record shapes, envelope, session graph, cursor
> semantics). Principles pages never contain wire shapes; spec pages cite
> the principles instead of restating them.

## The contract in one line

The contract is one ordered, resumable record stream. Records split into three kinds
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
| [record-stream.md](record-stream.md) | Why one stream with three record kinds? What exactly is an event, a request, a response? What does an event body carry? |
| [attribution.md](attribution.md) | How do records self-attribute? Why is attribution a field, not a channel? How is usage exposed? |
| [session-graph-and-cursor.md](session-graph-and-cursor.md) | What goes in the session graph, and how does resumable reading work? |
| [runtime-matrix.md](runtime-matrix.md) | Which attribution tier does each shipped adapter declare, on what native evidence, and what are adapters forbidden to do? |

For each runtime's native calls, resume behavior, and current mapping into
this contract, read [`../runtimes/`](../runtimes/README.md).

All examples in these pages are illustrative: seq values and field contents
are invented; the record shapes and invariants are normative. Field names
follow the TypeScript contracts.

## What the contract covers

Implemented by every adapter (claude, codex, pi, grok, kimi) and pinned by
the shared behavior suite (`sea-trial/cases/session.ts`):

- one stream of `event` / `request` / `response` records with a dense
  monotonic `seq`, `sessionId`, `agentPath`, optional runtime-native
  `spanId`, and `receivedAt`;
- every runtime frame recorded verbatim as an event (`type`, `native`) with
  oar's typed `views` beside it — nothing gated, nothing dropped, nothing
  synthesized; the turn's start is the prompt request, its end the
  runtime's own completion event;
- control as records: prompt / steer / queue / abort / dispose requests
  answered `accepted` / `rejected`; runtime→app requests recorded `toApp`
  and oar's automatic answer as `answered`; the process exit as `exited`;
- queries as folds: `model()`, `usage()`, `contextUsage()` are projections
  over `records()`;
- the cursor for the lifetime of the adapter process: `subscribe(observer,
  {sessionId, afterSeq})` replays the retained records after that position
  and continues live, without loss or duplication;
- the session graph with true sessions only, and an explicit attribution
  tier per adapter (`capabilities.attribution`);
- `SessionOptions.resume` reopening the runtime-native conversation with a
  fresh stream starting at `seq` 0.

## Open decisions

Three points remain deliberately **not settled**; the pages flag them where
they appear:

1. **`causedBy` stays deleted?** A causal-link field between records was
   removed in v0.7 because no consumer scenario required it. The removal is
   still open to reversal.
2. **External compaction.** Compacting a session externally (new session +
   injected summary prompt), layered above runtime-native compaction
   ([hard problem 14](../design/hard-problems.md#beyond-a-single-local-process)),
   is designed but not yet folded into this spec.
3. **Capability declaration beyond attribution.** `SessionCapabilities`
   declares steer, queue durability and the attribution tier. A fuller
   typed surface (what each adapter supports, with typed `unsupported`) is a
   candidate for the next revision.

## Version lineage

v0.3 attribution dimensions established → v0.4 ACP spec evidence → v0.5
kimi-cli native-wire evidence → v0.6 ACP gap wording corrected + kimi-code
KAP evidence → v0.7 review convergence (usage compressed to one constraint,
`fact` renamed `event`, synthesized turn boundaries deleted, cursor
semantics settled, `causedBy` deleted) → v0.8 element-wise deletion pass
(everything without a concrete breaking scenario was cut) → **v1.0
implementation** (2026-09-11):
`EventBody` fixed as `{type, native, views}`, `views` a list because one
frame can carry several readings; control responses `accepted` /
`rejected`, plus `answered` for oar's replies to `toApp` requests and
`exited` for the observed process exit; `queue` added as a request kind;
`SessionCapabilities` with the attribution tier; the cursor honored for
the lifetime of the adapter process.

## Legend

Record markers, used symbol+word so nothing depends on color:

- ✓ `event` — the runtime's own words
- ◆ `request` — an action record that expects an outcome
- ◇ `response` — always points at a request
- ○ absence — an outcome that was never observed (honest gap)

Evidence tags: `[src]` vendor source code (pinned commits where noted) ·
`[sym]` binary symbols · `[env]` observed
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
  affected row in [runtime-matrix.md](runtime-matrix.md) ↔ the runtime's
  page in [`../runtimes/`](../runtimes/README.md). Every field added earns
  its place with a concrete scenario that breaks without it, stated in the
  contract's own comments.
- **Where new material belongs.** *Why* a position holds (principles,
  evidence, failure modes) goes to [`docs/design/`](../design/README.md);
  *what* the contract is (shapes, semantics, per-runtime mapping) goes
  here. Spec pages cite design pages instead of restating them, and
  design pages never contain wire shapes.
- **Index and pointers.** Adding or removing a page means updating the
  table above and the pointer in the root `README.md` in the same commit.
- **Version discipline.** A semantic change to the contract bumps the
  version in the status banner and extends the version lineage above; flag
  anything deliberately unsettled under "Open decisions".
