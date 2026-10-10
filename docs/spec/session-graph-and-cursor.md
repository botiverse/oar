# Session graph and cursor

> Part of the [record-stream spec](README.md). Related design pages:
> [liveness](../design/liveness.md),
> [hard problems 13-15](../design/hard-problems.md#beyond-a-single-local-process).

## The session graph holds true sessions only

Derived sessions (grok, codex and OpenCode v2 children) form parent/child structure;
without an explicit graph, consumers cannot answer "where did sess-B come
from".

A claude subagent is not a session; it is an entity on `agentPath`.
Putting agent parent/child in the session graph would commit, inside the
graph itself, the merge the hard constraint in
[attribution.md](attribution.md) forbids: collapsing session and agent into
one dimension. The graph therefore holds true sessions only; agent
parent/child is expressed by `agentPath` plus the spawning `tool_call`
record. `SessionNode` carries no `kind` field: it is derivable from the
in-edge (no in-edge = root, `tool_call` edge = derived child), and the same
information is not stored twice.

- grok (ACP): explicit parent session → child session (independent
  sessionId) = a real session-derivation edge. [src]
- codex (app-server): a child thread is a derived child session; the edge
  comes from the collaboration item naming it
  (`subAgentActivity.agentThreadId`, `receiverThreadIds`). [env 0.149.0]
- OpenCode v2 (ACP): `update._meta["opencode/child-session"]` names the
  child id and its actual `parentID`, including nested children.
- claude: `parent_tool_use_id` is agent parent/child and produces no new
  session; carried by `agentPath`, not in the graph. [sym]
- cursor: a subagent's updates arrive inside the parent's `task` call and
  produce no new session; carried by `agentPath`, not in the graph. [env]

```ts
interface SessionNode { id: string; }
interface SessionEdge { parent: string; child: string; via: "tool_call"; }
```

### Example 5 · What enters the graph, what does not

```
grok:   sess-A ──tool_call──▶ child session sess-B   (session derivation; child has its own sessionId → in the graph)
codex:  thread-A ──tool_call──▶ child thread-B       (same shape; the child's records carry sessionId = thread-B, agentPath [])
claude: root ──tool_call(call_3)──▶ subagent "a1"    (agent parent/child → NOT in the graph; expressed by agentPath)
```

Edges are emitted only when a runtime reports a tool call spawning a child
session. `SessionOptions.resume` reopens the same node with a fresh stream
at seq 0, so it is not an edge. Host continuity between distinct sessions
(external compaction) is never an edge either: the new session's first
prompt carries the summary as its input, and nothing links the two
sessions in the graph.

A node's records are read by its own `sessionId`; the Session folds never
fold a child node's records into the root
([record-stream.md](record-stream.md#the-rules)).

## The graph is in the records

The native frame establishing a pair carries
`session_linked { parent, child, via: "tool_call" }` in its events. Codex
collaboration items, ACP lineage notifications and OpenCode v2 child
attribution use this same event; the original native payload stays on that
frame. Hosts with an exhaustive event switch must handle `session_linked`.

`graphOf(records)`, exported by the root, browser and observe entries, folds
these facts into a `SessionGraph`. Each record's `sessionId` and each edge's
endpoints establish nodes. Repeated edges are deduplicated. A foreign id
alone establishes only a node; it never implies that the root spawned it.
An empty log has an empty graph. `Session.graph()` retains the result of
this same fold, updated as each record is appended, so querying it does not
scan the log again. Node ids have a Set index. The live graph starts with
the session's own id, preserving the root before the first record; replay
learns the root when a record names it. Once the root is recorded, JSON
replay and live observers see the same nodes and edges at the same cursor.

Adapter authors put the event returned by `kernel.link(edge)` in the source
frame's `events` before `kernel.frame(...)`. The helper does not mutate
separate graph state. The former out-of-band `kernel.node(id)` is removed;
record envelopes and `session_linked` supply all observed nodes.

`usageOf(records, sessionId)` derives this graph automatically. Its optional
explicit graph argument still overrides the derivation. The session view
uses the same usage fold: `usage.total` remains the root's total, while
`usage.withChildren` adds each reachable child's latest reported total,
including nested children, once. Reports can precede lineage and repeated
cumulative reports replace the earlier amount. Child context fullness and
native-only ledgers do not become token totals. Grok's root ledger may
already include a child, so its child ledgers are not added again. Background
children finishing after the parent prompt can be missing from OAR totals,
although independent automatic root follow-ups are counted. Graph replay
does not repair that
[accounting gap](../runtimes/grok.md#context-usage-billing-and-compaction).

For incremental views, preserve the whole checkpoint, including
`sessionGraph` and the `usageBySession` Map and its nested `agents` Maps.
These retain child totals that arrive before the edge. The existing root
`usageByAgent` and `usageTotal` fields remain available. Start a fresh view
for each recorded run; replaying raw records avoids checkpoint-version
migration. Records from older OAR versions without `session_linked` cannot
recover their edges, so `withChildren` stays absent unless an explicit graph
is supplied to `usageOf`.

## The resumable cursor

Consumers (realtime UIs, offline writers) must reconnect after a disconnect
and continue reading without loss or duplication; offline replay depends on
it for positioning.

**Semantics: sequence determinism within a stream.** The total order of a
stream is uniquely determined by `seq`; identity and positioning rest on
`seq` alone, and `receivedAt` is observation metadata. While the adapter
process lives, a cursor continues in memory without loss or duplication.
After the process dies, the replay source is the host's own persisted log of
those records, never the runtime's history: native storage is not isomorphic
to the wire and cannot reproduce it, so a rebuild from it is not implemented and
was refused as a readback
([decision](../design/decisions.md#session-history-readback-2026-09-15);
[replay boundary](../design/foundations.md#replay-boundary)). oar has no
storage layer of its own
([decision](../design/decisions.md#a-storage-layer-2026-09-03)).

- `SessionOptions.resume` takes a runtime-native id and reopens the
  conversation; the cursor sinks resumable reading to the record level.
- Counterexample: kimi-cli's `wire.jsonl` has wall-clock timestamps only,
  no seq. `_handle_replay` replays the entire log from the start *and*
  re-sends historical requests as live requests, so approvals already
  answered get asked again: the cost of "no cursor + no replay/live
  distinction". [src: wire/file.py; wire/server.py:797-880]

```ts
interface Cursor { sessionId: string; afterSeq: number; }
// Session.rawEvents(observer, cursor) replays every retained record with
// seq > afterSeq synchronously, then continues live;
// Session.events(observer, { cursor }) does the same for the flat Events;
// Session.records() is the retained log. A cursor for another session id
// throws. Pinned by sea-trial `session.cursor-replays-without-loss-or-duplication`.
```

A cursor has no per-agent filter: for a single-agent view, resume the whole
stream and filter client-side by `agentPath`
([decision](../design/decisions.md#a-per-agent-cursor-filter-2026-09-03)).

**Scope of the cursor.** The kernel retains every record for the lifetime
of the adapter process, so a reconnecting subscriber misses nothing and
repeats nothing. `SessionOptions.resume` opens a fresh stream at `seq` 0 on
the runtime-native conversation; each [runtime page](../runtimes/README.md)
records what its native replay surface offers.

### Example 6 · Reconnect, and after death

```
Consumer holds {sessionId:"s1", afterSeq:41} at disconnect time.
── process alive: reconnect and continue from seq=42, no loss, no duplication.
── process dead:  replay comes from the host's persisted records; a resume
                  opens a fresh stream at seq 0, so the host keeps a distinct
                  streamId per stream (see conversation.md).
Completion converges per agent (agentPath), not per parent turn; see
hard spot 2 in runtime-matrix.md.
```
