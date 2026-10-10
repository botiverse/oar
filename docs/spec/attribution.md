# Attribution and usage

> Part of the [record-stream spec](README.md). Related design pages:
> [hard problems 9-10](../design/hard-problems.md#attribution-the-most-underestimated-part),
> [foundations](../design/foundations.md).

## Attribution is a field on the record, not a transport channel

Sub-agent and parent-agent records interleave in the same stream, and
consumers must be able to answer "which agent does this record belong to".
That needs an attribution mark on the record, not a second transport
channel. "Multiplexing" means main and sub agents sharing one stream, never
multiple control planes.

Attribution is the single field `agentPath` (the leaf element identifies
the stream; `[]` means root). No second encoding of the same dimension is
carried.

### Evidence: every shipped runtime is single-connection, with attribution as a frame field

- claude: `Task` can start parallel sub-agents; their messages are
  flattened into one stream-json output, linked by `parent_tool_use_id`.
  [sym]
- codex: one app-server connection; a child is its own thread whose
  notifications arrive on the parent's connection, linked by
  `subAgentActivity.agentThreadId`, each thread reporting its own running
  total in `thread/tokenUsage/updated`. [env: `experiments/codex-child-threads.ts`]
- grok (ACP): a child has its own ACP sessionId but travels the same ACP
  connection. [src]
- cursor (`@cursor/sdk`, in process): no connection at all; a child's
  updates arrive through the parent run's `onDelta` as `tool-call-delta`
  wrappers keyed by the `task` call id. [env]
- kimi-cli (native wire): sub-agents open no new connection; the parent
  wire receives `SubagentEvent{parent_tool_call_id, agent_id,
  subagent_type, event}` wrapper records sharing the one `_write_queue`
  with ordinary events. [src: wire/types.py:242; subagents/runner.py:393-428]
- kimi-code 0.38 (native KAP over WebSocket): one connection + one session;
  the agent graph's key is `(session_id, agent_id)` and `agent_id` is a
  frame field, not a socket per sub-agent.
  [src: kimi-code@0999454 ws-control.ts:35-180;
  sessionEventBroadcaster.ts:414-543]
- pi: no native sub-agents; naturally single-stream. [src]

A transport stream per sub-agent would permanently lose total order, which
is why [two channels were refused](../design/decisions.md#separate-channels-for-control-and-facts-2026-09-03);
attribution does not readmit them through the back door.

## The record envelope: self-certifying attribution

Every record certifies its own attribution (which session, which agent), is
orderable, and is locatable, so consumers can demux, attribute, and resume.
The envelope is `sessionId` / `agentPath` / optional `spanId` / `seq` /
`receivedAt` (shape in [record-stream.md](record-stream.md#record-contracts));
nothing in it is invented by oar except the ordering. Each field passes a
deletion test:

| Field | Without it |
|---|---|
| `sessionId` | grok's child sessions and codex's child threads interleave on one connection ([env] 0.149.0) and cannot be demultiplexed. It has a real referent, not invented by oar: claude's `CLAUDE_CODE_SESSION_ID`, codex's `CODEX_SESSION_ID`. [env][src] |
| `agentPath` | `[]` = root, `[...]` = sub-agent lineage. The cross-agent ID collision ([runtime-matrix.md](runtime-matrix.md), hard spot 1) has no solution. |
| `spanId?` | Runtime-native turn id. A mandatory turn id would drop pi's session-scoped facts ([decision](../design/decisions.md#control-objects-as-the-event-model-2026-09-03)). |
| `seq` | Monotonic cursor basis; replay determinism covers `seq` only ([session-graph-and-cursor.md](session-graph-and-cursor.md)). |
| `receivedAt` | Best-effort observation time, explicitly outside the determinism guarantee; identity rests on `seq`. |

### Example 4 · Parent/child interleaving + the composite key

```
seq=88  ✓ frame  root          tool_call {id:"call_3", Task → spawn sub-agent}
seq=89  ✓ frame  path=["a1"]   assistant_text "Let me check first…"
seq=90  ✓ frame  root          assistant_text "Meanwhile I'll look elsewhere…"
        ↳ parent and child interleave in one stream; agentPath lets every
          record certify its own attribution
seq=91  ✓ frame  path=["a1"]   tool_call {id:"call_1", …}
        ↳ sharing a name with a historical call_1 in the parent stream is
          fine: identity = (agentPath, id), and (["a1"],"call_1") ≠
          ([],"call_1"). See hard spot 1 in runtime-matrix.md
```

## The attribution spectrum: a protocol responsibility, not app-layer improvisation

If attribution is not in the protocol, every app reimplements parent
linkage and token splitting, each inconsistently; independent codebases
already show the degeneration (adapter red lines in
[runtime-matrix.md](runtime-matrix.md)).

- claude: `parent_tool_use_id` (linkage) → `agentPath`; the session total
  is `result.modelUsage` (every model call, subagents and compaction
  included), the root's entry the main loop's `result.usage`, and the
  subagents' spend unattributed: only a subagent's first `assistant` frame
  carries `parent_tool_use_id`, its usage the stream-start value. [sym]
  [env 2.1.292]
- codex: child threads → derived child sessions, with per-thread usage.
  [env]
- grok (ACP): nested sessions; child has its own sessionId + per-child
  usage. [src]
- cursor (`@cursor/sdk`): attributed; a child's updates carry
  `agentPath = [...parentPath, taskCallId]`, and each run's `turn-ended`
  usage is the root's. [env]
- antigravity (ACP): opaque; agy_acp_server 1.2.1 flattens the child's
  tool calls and text onto the parent session (the child id survives only
  as a `toolCallId` prefix) and reports no usage, so only the root is
  marked. [env]
- kimi (ACP): opaque; an internal graph exists, but the default ACP server
  subscribes only to the main agent. The protocol honestly marks root only;
  fabricating a child graph from display text is forbidden. [src]
- opencode (ACP): opaque; a `task` subagent runs in a child session of its
  own, but `opencode acp` forwards only its own sessions' parts, so the
  parent's `task` tool call is all that arrives. [src] opencode 1.18.34
  `acp/event.ts`
- kimi-cli (native wire): full attribution, recursively unbounded
  (`SubagentEvent(event=SubagentEvent(...))`). Both of its offline
  consumers flatten the wrappers and lose attribution, which is
  unrecoverable once flattened; the protocol must therefore guarantee
  attribution on the record. Unbounded recursion is also why `agentPath` is
  an array: a single `parent` field cannot hold the lineage.
  [src: wire/types.py:242; vis/api/sessions.py:28-42]
- kimi-code (native KAP): agent graph key = `(session_id, agent_id)`;
  every frame carries `agent_id`. [src]
- ACP's attribution gap: zero hits for `parent*` / `subagent*` / `child*`
  across four schemas. In org Discussion #690 real clients can only guess
  parent/child from `_meta` / `rawInput`; spec-repo draft PR #855 offers a
  candidate fix (child session + parentSessionId / parentToolCallId /
  subagentId), unmerged. Status: formally discussed, a candidate fix in a
  draft RFD, no protocol commitment. [acp]

**Hard constraint:** the protocol must never merge session and agent into
one dimension. The ACP draft chooses child-session (#3); kimi-cli and
kimi-code choose record-level attribution (#2). The protocol must express
both; otherwise grok's child sessions (and codex's child threads, [env]
0.149.0) can only be faked as pseudo-agents, or KAP's agents faked as
pseudo-sessions. A child session's records therefore carry `agentPath []`
under their OWN `sessionId`, and the Session folds scope to the root
session ([record-stream.md](record-stream.md#the-rules)).

**Full-spectrum principle:** the protocol supports opaque (#1) →
attribution (#2) → nested-session (#3). oar carries only the structure the
runtime exposes and never fabricates (kimi stays opaque; `agentPath` stays
at root). Vendor escape hatches (grok's `_x.ai/*`) are per-runtime
capabilities declared explicitly on the oar side, not protocol guarantees.
[acp]

## Usage: one constraint

**oar guarantees that the externally exposed usage numbers are correct.**
The external shape: a session total, plus an optional per-agent breakdown
that is deduplicated and, with `unattributed`, directly summable (sum =
total), plus `withChildren`. Which runtime view is authoritative and how to
deduplicate (grok's multiple overlapping views, codex's per-thread totals
over each thread's life, claude's main loop beside its every-call total,
pi's flat usage) sinks entirely into each runtime adapter and never crosses
the protocol surface.

- **The total is everything the runtime reports this session spent.** Where
  the runtime reports a session total of its own beyond its agents' figures
  (claude's `modelUsage`: main loop, subagents, sidechains, compaction), it
  is the total, and the adapter puts it on the `usage` event as `total`.
  Elsewhere the agents' figures sum to it.
- **An honest remainder.** `unattributed` is what the total includes that no
  agent entry accounts for: the total less the breakdown, never split
  between agents by estimate. An agent gets an entry only where the runtime
  attributes its spend without guessing; claude's subagents get none
  ([claude](../runtimes/claude.md#token-totals)). Absent when the agents
  account for all of it.
- **Derived child sessions, added once.** `withChildren` is the root total
  plus each reachable child's independently reported total, including nested
  children, each counted once. `session_linked` records native lineage, and
  `graphOf(records)` lets both `usageOf` and SessionView compute the same
  amount in replay. Foreign session ids alone do not imply lineage.
  Codex reports independent per-thread totals. Grok instead includes its
  children's calls in the root's prompt ledger; its child ledgers remain
  native-only and are not added again ([Grok evidence](../runtimes/grok.md#context-usage-billing-and-compaction)).
  OpenCode's context-only child reports supply no token total. The adapter
  resolves this accounting difference; hosts do not need runtime checks.
  `withChildren` is absent when no linked child reports independent token
  usage, and while the root's total is null. Older logs without lineage also
  leave it absent, unless a caller supplies an explicit graph to `usageOf`.


The protocol carries no usage `origin` or accounting-basis label
([decision](../design/decisions.md#a-usage-basis-label-2026-09-03)).

**Token totals count from when this Session opened, on every runtime**
([#169](https://github.com/botiverse/oar/issues/169)). A `usage` event's
`tokens` and `usage()` cover what this Session's own turns spent: a Session
that resumed a native session never includes what earlier Sessions on it
spent, so a host adds a conversation's Sessions up by summing their totals.
Native scopes differ and stay in the adapter. For pi, cursor and grok the
adapter adds up what this process reports, so their totals start at zero.
claude's `modelUsage` is a running total that a resumed process continues
from the previous one's ([env] 2.1.292); before this Session's first turn
the adapter asks claude `get_usage`, whose `session.model_usage` is that
running total, and subtracts it, model by model, from every later report.
When that answer does not come (a timeout, an error, no session totals),
the resumed Session's `usage` events carry `context` only and
`usage().total` stays null ([claude](../runtimes/claude.md#token-totals)).
codex's thread total spans the thread's life; after a resume codex
re-reports it once, before this Session's first turn starts, and the adapter
subtracts that report from every later root total, `cacheRead` and
`cacheWrite` included. It subtracts codex's own number and never estimates
one. Don't know, don't report: a resumed codex Session whose first turn
starts without that report (codex before 0.151.0) cannot tell its share, so
its `usage` events carry `context` only and `usage().total` stays null,
never the thread's lifetime figure
([codex](../runtimes/codex.md#connection-session-creation-and-resume)).

Usage itself is a seq-carrying `usage` event read from a frame on the
stream, and `usage()` is a fold returning `{ value, seq }` (the query rule
in [record-stream.md](record-stream.md)). Per-agent attribution rides the
envelope. [sym][src]

### Example 7 · What external usage looks like

```
External (protocol surface):
  session total:              input 45_231 / output 8_120   ← guaranteed correct, usable as-is;
                                                              null until the runtime has reported any
                                                              (never a guessed zero: kimi's ACP surface
                                                              carries context fullness only)
  optional per-agent split:   root  30_100 / 6_050
                              a1    10_131 / 1_070          ← deduplicated
  unattributed:                      5_000 / 1_000          ← in the total, no agent's (claude's subagents,
                                                              compaction); split + unattributed = total
  withChildren:               input 60_231 / output 9_120   ← the total plus each derived child session's, once
Adapter-internal (never crosses the protocol surface):
  grok    multiple overlapping views → adapter picks the authoritative one and dedups
  claude  latest modelUsage (every call, cumulative) → session total, less a resume's get_usage baseline;
          result usage (main loop, per turn)         → accumulated into the root's entry
  codex   per-thread totals over the thread's life → one child session per thread,
          less the total codex re-reports on resume
  pi      flat usage                 → session total only; no fabricated breakdown
```

### Cache reads and writes

`TokenTotals` carries two optional parts of `input`: `cacheRead` (input read
from the runtime's prompt cache) and `cacheWrite` (input written to it).
`input` keeps its meaning, all input with cache reads and writes included,
so a host can tell a wake that read the cache from one that rewrote it
without `input` changing under existing consumers
([#161](https://github.com/botiverse/oar/issues/161)).

- Each part is the runtime's own number, present only when the runtime
  reports it; the two are independent. A reported 0 is 0; an unreported part
  is absent, never derived from the other numbers.
- Both accumulate the way `input` does: per `agentPath` in the adapter, and
  summed over agents for the session total (or read off the runtime's own
  session total, claude's `modelUsage`), so `usage()` stays directly usable
  and its breakdown plus `unattributed` still sums to the total. A report
  without a part adds nothing to it; a part that has appeared stays.

| Runtime | `cacheRead` | `cacheWrite` | Evidence |
| --- | --- | --- | --- |
| claude | `cacheReadInputTokens` of each `result.modelUsage` model (total); `result.usage.cache_read_input_tokens` (root) | `cacheCreationInputTokens` of each model (total); `result.usage.cache_creation_input_tokens` (root) | both added into `input` (`inputTokens` and `input_tokens` exclude them); recorded `result` frames in the background-tasks and claude-usage replay fixtures [env] |
| cursor | `turn-ended.usage.cacheReadTokens` | `turn-ended.usage.cacheWriteTokens` | both added into `input`; `@cursor/sdk` 1.0.36 `TurnEndedUpdateSchema` [src], probe 2026-10-03 [env] |
| pi | assistant `usage.cacheRead` | assistant `usage.cacheWrite` | both added into `input`; pi-ai 1.0.4 `Usage` [src], pi-aimock replay fixture [env] |
| codex | `tokenUsage.total.cachedInputTokens` | `tokenUsage.total.cacheWriteInputTokens` | both already inside `inputTokens`; codex's own thread total, less the total re-reported on resume like `input` [src 4f39251a, env 0.154.0 / 0.160.0]; absent on a codex without the write field (below) |
| grok | `_meta.usage.cachedReadTokens` | `_meta.usage.cacheCreationTokens` | per-prompt ledger, summed per session like its input; live 1.0.25 answer: 1280 / 0 [env] |
| kimi, opencode, antigravity | absent | absent | no token totals reported, `usage().total` stays null |

Codex fills `cachedInputTokens` and `cacheWriteInputTokens` from the
Responses API's `input_tokens_details.cached_tokens` and
`cache_write_tokens`, both parts of `input_tokens` (codex-api
`sse/responses.rs` at 4f39251a; its test: input 100 = cache read 40 + cache
write 60) [src]. A codex built before the write field (openai/codex#33454)
reports `cacheRead` only.

Grok's `cacheCreationTokens` was 0 in the one recorded ledger that carried
it, so whether grok's `inputTokens` includes a nonzero cache write is
unverified.
