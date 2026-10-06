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
  `subAgentActivity.agentThreadId`, each thread reporting its own cumulative
  `thread/tokenUsage/updated`. [env: `experiments/codex-child-threads.ts`]
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

- claude: `parent_tool_use_id` (linkage) → `agentPath`; usage from `result`
  frames is accumulated per `agentPath`. [sym]
- codex: child threads → derived child sessions, with per-thread cumulative
  usage. [env]
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
that is deduplicated and directly summable (sum = total). Which runtime
view is authoritative and how to deduplicate (grok's multiple overlapping
views, codex's per-thread cumulative totals, pi's flat usage) sinks entirely
into each runtime adapter and never crosses the protocol surface. The
protocol carries no usage `origin` or accounting-basis label
([decision](../design/decisions.md#a-usage-basis-label-2026-09-03)).

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
                              a1    15_131 / 2_070          ← deduplicated; sums to the total
Adapter-internal (never crosses the protocol surface):
  grok    multiple overlapping views → adapter picks the authoritative one and dedups
  claude  result usage per agentPath → adapter accumulates the breakdown
  codex   per-thread cumulative usage → one child session per thread
  pi      flat usage                 → session total only; no fabricated breakdown
```
