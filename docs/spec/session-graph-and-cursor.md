# Session graph and cursor

> Part of the [v2 spec, draft v0.8](README.md). Related design pages:
> [liveness](../design/liveness.md),
> [hard problems 13–15](../design/hard-problems.md#beyond-a-single-local-process).

## The session graph holds true sessions only

**Why:** derived sessions (grok children) and transcript branches (pi
forks) form parent/child structure; without an explicit graph, consumers
cannot answer "where did sess-B come from".

Ablation note: v0.7's graph held both agent parent/child (claude
subagents) *and* session derivation. But a claude subagent is not a
session — it is an entity on `agentPath`. Putting it in the session graph
commits, inside the graph itself, exactly the merge the hard constraint in
[attribution.md](attribution.md) forbids: collapsing session and agent
into one dimension. v0.8 narrows the graph to true sessions only; agent
parent/child is expressed by `agentPath` plus the spawning `tool_call`
record. `SessionNode.kind` is deleted in the same pass — it is derivable
from the in-edge (no in-edge = root, `fork` edge = branch, `tool_call`
edge = derived child), and the same information is not stored twice.

- grok (ACP): explicit parent session → child session (independent
  sessionId) = a real session-derivation edge. [src]
- pi: the session tree (fork / parentId) is transcript branching, not
  sub-agents. [src: pi session-manager]
- claude/codex: `parent_tool_use_id` is agent parent/child and produces no
  new session — carried by `agentPath`, not in the graph. [sym]

```ts
interface SessionNode { id: string; }
interface SessionEdge { parent: string; child: string; via: "tool_call" | "fork" | "resume"; }
```

### Example 5 · What enters the graph, what does not

```
grok:   sess-A ──tool_call──▶ child session sess-B   (session derivation; child has its own sessionId → in the graph)
pi:     sess-A ──fork──▶ sess-A'                     (transcript branch → in the graph)
claude: root ──tool_call(call_3)──▶ subagent "a1"    (agent parent/child → NOT in the graph; expressed by agentPath)
```

## The resumable cursor

**Why:** consumers (realtime UIs, offline writers) must reconnect after a
disconnect and continue reading without loss or duplication; offline
replay depends on it for positioning.

**Semantics (settled in v0.7; boundary tightened in v0.8): sequence
determinism, replay on the runtime side.** The total order of a session is
uniquely determined by `seq`. Adapter constraint: the same record replayed
twice gets the same `seq`. The determinism guarantee covers `seq` *only*:
after the process dies, the adapter rebuilds the stream from the runtime's
own resume / rollout / replay log, and the observation time `receivedAt`
cannot be reproduced there — identity and positioning rest on `seq` alone,
and `receivedAt` is best-effort metadata (otherwise "same record replayed
twice → same seq" would be unsatisfiable). Process alive → in-memory
continuation within the session; process dead → rebuild from the runtime
log. oar grows no storage layer because of this — a deliberate design
ruling: oar does not own storage.

- v1 already had session-level resume (`SessionOptions.resume` takes a
  runtime-native id) plus a monotonic envelope `seq`; v2 sinks resume to
  the record level. [v1: session.ts:30-31,57,162]
- Counterexample: kimi-cli's `wire.jsonl` has wall-clock timestamps only,
  no seq. `_handle_replay` replays the entire log from the start *and*
  re-sends historical requests as live requests — approvals that were
  already answered get asked again. That is precisely the cost of "no
  cursor + no replay/live distinction".
  [src: wire/file.py; wire/server.py:797-880]

```ts
interface Cursor { sessionId: string; afterSeq: number; }
// v0.7's streamId? filter was ablated: no consumer ever demonstrated
// "resume just one sub-agent". For a single-agent view, resume the whole
// stream and filter client-side by agentPath — the protocol keeps no
// field for an unevidenced need.
```

### Example 6 · Reconnect, and rebuild after death

```
Consumer holds {sessionId:"s1", afterSeq:41} at disconnect time.
── process alive: reconnect and continue from seq=42 — no loss, no duplication.
── process dead:  the adapter rebuilds from the runtime's own rollout/replay log;
                  the same record replayed twice gets the same seq, so
                  afterSeq=41 still positions precisely.
Completion converges per agent (agentPath), not per parent turn — see
hard spot 2 in runtime-matrix.md.
```
