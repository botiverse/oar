# Session graph and cursor

> Part of the [record-stream spec](README.md). Related design pages:
> [liveness](../design/liveness.md),
> [hard problems 13-15](../design/hard-problems.md#beyond-a-single-local-process).

## The session graph holds true sessions only

**Why:** derived sessions (grok children) and transcript branches (pi
forks) form parent/child structure; without an explicit graph, consumers
cannot answer "where did sess-B come from".

A claude subagent is not a session; it is an entity on `agentPath`.
Putting agent parent/child in the session graph would commit, inside the
graph itself, exactly the merge the hard constraint in
[attribution.md](attribution.md) forbids: collapsing session and agent
into one dimension. The graph therefore holds true sessions only; agent
parent/child is expressed by `agentPath` plus the spawning `tool_call`
record. `SessionNode` carries no `kind` field; it is derivable from the
in-edge (no in-edge = root, `fork` edge = branch, `tool_call` edge =
derived child), and the same information is not stored twice.

- grok (ACP): explicit parent session → child session (independent
  sessionId) = a real session-derivation edge. [src]
- codex (app-server): a child thread is a derived child session; the edge
  comes from the collaboration item naming it (`subAgentActivity.agentThreadId`,
  `receiverThreadIds`). [env 0.149.0]
- pi: the session tree (fork / parentId) is transcript branching, not
  sub-agents. [src: pi session-manager]
- claude: `parent_tool_use_id` is agent parent/child and produces no
  new session; carried by `agentPath`, not in the graph. [sym]

```ts
interface SessionNode { id: string; }
interface SessionEdge { parent: string; child: string; via: "tool_call" | "fork" | "resume"; }
```

### Example 5 · What enters the graph, what does not

```
grok:   sess-A ──tool_call──▶ child session sess-B   (session derivation; child has its own sessionId → in the graph)
codex:  thread-A ──tool_call──▶ child thread-B       (same shape; the child's records carry sessionId = thread-B, agentPath [])
pi:     sess-A ──fork──▶ sess-A'                     (transcript branch → in the graph)
claude: root ──tool_call(call_3)──▶ subagent "a1"    (agent parent/child → NOT in the graph; expressed by agentPath)
```

A node's records are read by its own `sessionId`: the Session folds
(`model / usage / contextUsage`, `awaitTurnEnd`) scope to the root session
and never fold a child node's records into it (record-stream.md).

## The resumable cursor

**Why:** consumers (realtime UIs, offline writers) must reconnect after a
disconnect and continue reading without loss or duplication; offline
replay depends on it for positioning.

**Semantics: sequence
determinism, replay on the runtime side.** The total order of a session is
uniquely determined by `seq`. Adapter constraint: the same record replayed
twice gets the same `seq`. The determinism guarantee covers `seq` *only*:
after the process dies, the adapter rebuilds the stream from the runtime's
own resume / rollout / replay log, and the observation time `receivedAt`
cannot be reproduced there; identity and positioning rest on `seq`
alone, and `receivedAt` is best-effort metadata (otherwise "same record
replayed twice → same seq" would be unsatisfiable). Process alive →
in-memory continuation within the session; process dead → rebuild from
the runtime log. oar grows no storage layer because of this, a
deliberate design ruling: oar does not own storage.

- `SessionOptions.resume` takes a runtime-native id and reopens the
  conversation; the cursor sinks resumable reading to the record level.
- Counterexample: kimi-cli's `wire.jsonl` has wall-clock timestamps only,
  no seq. `_handle_replay` replays the entire log from the start *and*
  re-sends historical requests as live requests; approvals that were
  already answered get asked again. That is precisely the cost of "no
  cursor + no replay/live distinction".
  [src: wire/file.py; wire/server.py:797-880]

```ts
interface Cursor { sessionId: string; afterSeq: number; }
// No per-agent resume filter: no consumer has demonstrated "resume just
// one sub-agent". For a single-agent view, resume the whole
// stream and filter client-side by agentPath; the protocol keeps no
// field for an unevidenced need.
// Shipped: Session.subscribe(observer, cursor) replays every retained
// record with seq > afterSeq synchronously, then continues live;
// Session.records() is the retained log. A cursor for another session id
// throws. Pinned by sea-trial `session.cursor-replays-without-loss-or-duplication`.
```

**Scope of the cursor.** The kernel retains every record for the lifetime
of the adapter process, so a reconnecting subscriber misses nothing and
repeats nothing. `SessionOptions.resume` opens a fresh stream at `seq` 0 on
the runtime-native conversation; each [runtime page](../runtimes/README.md)
records what its native replay surface offers.

### Example 6 · Reconnect, and rebuild after death

```
Consumer holds {sessionId:"s1", afterSeq:41} at disconnect time.
── process alive: reconnect and continue from seq=42, no loss, no duplication.
── process dead:  the adapter rebuilds from the runtime's own rollout/replay log;
                  the same record replayed twice gets the same seq, so
                  afterSeq=41 still positions precisely.
Completion converges per agent (agentPath), not per parent turn; see
hard spot 2 in runtime-matrix.md.
```
