# Specification

> **Status: SHIPPED.** The record-stream contract below is what
> `@botiverse/oar` emits today; `packages/oar/src/contracts/session.ts` and
> `records.ts` are the normative TypeScript.

The surrounding system model is in [`docs/design/system.md`](../design/system.md):
this specification is the evidence boundary inside that model. Hosts add
policy, storage, scheduling, and presentation around it without changing
record meaning.

## The contract in one line

The contract is one ordered, resumable record stream. Records (`RawEvent`)
split into three kinds by obligation (frame / request / response), every
record self-attributes (session graph + `agentPath`), and a monotonic `seq`
on the stream is the cursor. Consumers read the stream as flat, attributed
`Event`s through `Session.events()`; `rawEvents()` and `records()` are the
stream itself.

The external promise: everything the runtime said is in the stream, nothing
oar didn't observe is in it, every record knows whose it is, and the stream
is resumable from any position.

**Non-goals:** multiple transport channels
([decision](../design/decisions.md#separate-channels-for-control-and-facts-2026-09-03));
multiple control planes and concurrent prompt queueing
([decision](../design/decisions.md#concurrent-control-planes-and-prompts-2026-09-03));
a storage layer ([decision](../design/decisions.md#a-storage-layer-2026-09-03));
usage *derivation* (cumulative/epoch/boundary views are consumer business).

## Pages

| Read | To answer |
|---|---|
| [record-stream.md](record-stream.md) | Why one stream with three record kinds? What exactly is an event, a request, a response? What does an event body carry? |
| [attribution.md](attribution.md) | How do records self-attribute? Why is attribution a field, not a channel? How is usage exposed? |
| [session-graph-and-cursor.md](session-graph-and-cursor.md) | What goes in the session graph, and how does resumable reading work? |
| [runtime-matrix.md](runtime-matrix.md) | Which attribution tier does each shipped adapter declare, on what native evidence, and what are adapters forbidden to do? |
| [conversation.md](conversation.md) | Input identity, native user messages and replayable conversation projection |
| [subagents.md](subagents.md) | Child sessions as subagents: spawn, reports, follow-ups, delivery into a parent, limits, and `oar mcp` |
| [inventory.md](inventory.md) | Independent skills, MCP and tool queries, cwd defaults, coverage and failure semantics |
| [account-usage.md](account-usage.md) | Account quota queries and failure reason semantics |
| [update.md](update.md) | Runtime update checks and upgrades through each runtime's own updater, and how outcomes are judged |
| [login.md](login.md) | Signing a runtime in through its own login without a terminal, the sign-in status query, and the secret-handling rules |

For each runtime's native calls, resume behavior, and current mapping into
this contract, read [`../runtimes/`](../runtimes/README.md).

All examples in these pages are illustrative: seq values and field contents
are invented; the record shapes and invariants are normative. Field names
follow the TypeScript contracts.

## What the contract covers

Implemented by every adapter (claude, codex, pi, grok, kimi, opencode, cursor,
antigravity), pinned by the shared behavior suite
(`sea-trial/cases/session.ts`, which CI runs on the mock and the claude,
codex and pi aimock backends, and which runs on any installed runtime with
`OAR_TEST=<id>`) and by `experiments/live-contract.ts` on a real login for
every adapter:

- one stream of `frame` / `request` / `response` records with a dense
  monotonic `seq`, `sessionId`, `agentPath`, optional runtime-native
  `spanId`, and `receivedAt`;
- every runtime frame recorded verbatim as a `Frame` (`type`, `native`)
  with oar's typed `events` beside it: nothing gated, nothing dropped,
  nothing synthesized; the turn's start is the prompt request, its end the
  runtime's own completion event;
- the consumer face: `events()` delivers every reading as a flat `Event`
  (an event body plus the record's envelope): native user messages, text,
  reasoning, tool call start / progress / end, turn end, usage, model,
  effort, compaction start / end, retry and tasks as the runtime says them,
  plus `turn_started`, `input_withdrawn`, `control_rejected`, `app_request`,
  `app_answered` and `exited` read off request/response records; a pure
  projection (`eventsOf`) over the stream, never a second source of truth;
- control as records: prompt / steer / queue / withdraw / abort / dispose requests
  answered `accepted` / `rejected` (a rejection carries a typed `code` beside
  its prose `reason`); the `Session` returns those records read, as a
  `ControlOutcome`; runtime→app requests recorded `toApp` and oar's
  automatic answer as `answered`; the process exit as `exited`;
- queries as folds: `model()`, `effort()`, `usage()`, `contextUsage()` and
  `status()` project over `records()` and return `{ value, seq }`, where
  `seq` is the last record the fold consumed (or `-1` before any record);
  `busy` is rejected exactly while `status()` says `running`;
- the cursor for the lifetime of the adapter process: `rawEvents(observer,
  {sessionId, afterSeq})` (and `events(observer, { cursor })`) replays the
  retained records after that position and continues live, without loss or
  duplication;
- the session graph with true sessions only, and an explicit attribution
  tier per adapter (`capabilities.attribution`);
- `SessionOptions.resume` reopening the runtime-native conversation with a
  fresh stream starting at `seq` 0;
- `SessionOptions.effort` applied through each runtime's native channel and
  read back: a runtime that would run another level, or has no channel,
  refuses the open (contract comment on `SessionOptions.effort`; per-runtime
  channels in [`../runtimes/`](../runtimes/README.md));
- `SessionOptions.mcpServers` attaching MCP servers (stdio or streamable
  HTTP, ACP's `McpServer` shape) to that session only, on top of the
  runtime's own and given again on `resume`; their `env` and `headers`
  values never reach a record, event or error; refused by a runtime whose
  channel is not verified
  ([channels](runtime-matrix.md#refused-session-options));
- external compaction as a new session whose first prompt carries the
  summary input; nothing links the new session to the prior one, and no
  session-graph edge is created
  ([session-graph-and-cursor.md](session-graph-and-cursor.md)).

## Open decisions

Two points remain deliberately **not settled**; the pages flag them where
they appear:

1. **Causal links between records.** No consumer scenario has required a
   causal-link field between records (a `causedBy`-style pointer). Adding
   one stays open.
2. **Capability declaration beyond attribution.** A whole operation a
   runtime cannot do is a member it lacks (`Session.steer`,
   `Session.withdraw`, `Runtime.accountUsage`;
   [capabilities](../design/capabilities.md)); an option it
   cannot honor is refused with an `UnsupportedOptionError`, declared up
   front in `Runtime.refusedSessionOptions` where it is known before the
   session opens
   ([refused session options](runtime-matrix.md#refused-session-options));
   `SessionCapabilities` declares queue durability, the attribution tier and
   image input. Which further facts deserve a declaration (a remote
   environment, for one) stays open.

## Legend

Record markers, used symbol+word so nothing depends on color:

- ✓ `frame`: the runtime's own words
- ◆ `request`: an action record that expects an outcome
- ◇ `response`: always points at a request
- ○ absence: an outcome that was never observed (honest gap)

Evidence tags: `[src]` vendor source code (pinned commits where noted) ·
`[sym]` binary symbols · `[env]` observed runtime behavior · `[doc]`
official documentation · `[acp]` ACP spec/schema (pinned clone bb2ef8f7).

## How to maintain these docs

These pages are a contract, and a stale contract is worse than none.

- **Same-commit rule.** When code changes what the contract says (a
  record shape, envelope field, cursor semantics, an adapter's tier), the
  spec page changes in the same commit. Never "update the docs later".
- **What changes together.** Update as a unit: the code, the owning spec
  page, the affected row in [runtime-matrix.md](runtime-matrix.md), and the
  runtime's page in [`../runtimes/`](../runtimes/README.md). Every field
  added earns its place with a concrete scenario that breaks without it,
  stated in the contract's own comments.
- **Where new material belongs.** *What* the contract is (shapes,
  semantics, per-runtime mapping) goes here. *Why* a position holds
  (principles, evidence, failure modes) goes to
  [`docs/design/`](../design/README.md), and refused proposals to
  [`decisions.md`](../design/decisions.md). Spec pages cite design pages
  instead of restating them; design pages never contain wire shapes.
- **Index and pointers.** Adding or removing a page means updating the
  table above and the pointer in the root `README.md` in the same commit.
- **Snapshot, not journal.** These pages state the current contract only.
  A change rewrites the affected statements in place, with no "previously
  X, now Y" notes; git history carries the evolution. Flag anything
  deliberately unsettled under "Open decisions".
