# Runtime matrix, adapter red lines, and the two hard spots

> Part of the [record-stream spec](README.md). Related design pages:
> [hard problems 9–10](../design/hard-problems.md#attribution--the-most-underestimated-part),
> [foundations](../design/foundations.md).

## Per-runtime landing matrix

Native evidence and the shipped placement are combined below. The
**declared tier** column is what each adapter's `capabilities.attribution`
reports today; the other columns are native evidence. See the
[runtime programming-interface pages](../runtimes/README.md) for current
calls, resume semantics, and what each adapter still does not carry.

| runtime | declared tier | how children appear in the stream |
|---|---|---|
| claude | `attributed` | frames with `parent_tool_use_id` carry `agentPath = [...parentPath, taskCallId]`, nested through the Task call's own agent; child usage stays unattributed (unverified) |
| codex (app-server) | `nested` | notifications for other thread ids are child-session records (`sessionId` = the thread); a collab item naming the child adds a `tool_call` edge. [env] codex 0.149.0: the app-server delivers the child thread's notifications on the parent's connection; `subAgentActivity.agentThreadId` yields the edge (experiments/codex-child-threads.ts) |
| pi | `none` | pi has no native sub-agents; `agentPath` is always root |
| grok (ACP) | `nested` | `session/update` for other session ids are child-session records; vendor lifecycle notifications (names pinned from binary symbols, re-checked on grok 1.0.25; unverified live — no grok credentials on the probe machine) add edges when they name a parent |
| kimi (ACP) | `opaque` | `kimi acp` subscribes to the main agent only; the adapter records what arrives and fabricates nothing |

| runtime | sub-agent exposure | linkage | per-agent tokens | session graph | resume | evidence |
|---|---|---|---|---|---|---|
| claude | native subagent messages can share the stream | `parent_tool_use_id` | current transport's child usage attribution unverified | `agentPath` (not in graph) | native session id | [native/current mapping](../runtimes/claude.md) |
| codex (app-server) | native child threads and collaboration items arrive on the parent's connection ([env] 0.149.0) | `senderThreadId` / `receiverThreadIds`; `subAgentActivity.agentThreadId` ([env]: `started` on the root names the child, `interacted` on the child names the root) | both threads report cumulative `thread/tokenUsage/updated`; the child's is in its own session's records, not in the root `usage()` ([env]) | native thread topology; child threads are child sessions (see declared tier) | `threadId`; `expectedTurnId` is a steer precondition | [pinned schema/current mapping](../runtimes/codex.md) |
| pi | no native (host composes) | host-nested sessions | flat (host splits) | fork edges (in graph) | session id | [src] |
| grok (ACP) | nested sessions (#3), same connection | child has its own ACP sessionId | child usage lands in the child session's records ([src]; live unverified) | parent→child session edges (in graph, [sym]) | ACP `sessionId` | [native/current mapping](../runtimes/grok.md) |
| kimi (ACP) | opaque (#1): default subscribes main agent only | root `Agent` tool card only | no typed child usage exposed | nothing fabricated from display text | ACP `sessionId` | [native/current mapping](../runtimes/kimi.md) |
| kimi-cli (native wire) | wrapper records (#2): `SubagentEvent`, one stream | `parent_tool_call_id` + `agent_id` + `subagent_type` | child events self-attribute | `agentPath`, recursive (not in graph) | session / agent_id | [src] |
| kimi-code (native KAP) | agent graph (#2): key = `(session_id, agent_id)` | `subagentId` + `parentAgentId` + `parentToolCallId` + `runInBackground` | `subagent.completed` carries usage | `agentPath` (not in graph) | session / agent_id | [src] |

The #1/#2/#3 tiers are the attribution spectrum defined in
[attribution.md](attribution.md).

## Adapter red lines

**Why:** "the adapter drops attribution" appears in identical form in
mutually independent codebases, and upstream has confirmed it itself. When
the protocol lacks the attribution dimension, this is the adapter's
*inevitable* degeneration path — not accidental oversights. A session-id
entry filter (`if (params.sessionId !== opened.sessionId) return;`) is the
canonical shape of it: it throws away every child session's data and makes
a nested runtime artificially opaque.

- kimi-cli: its own ACP adapter has two `case SubagentEvent(): pass`
  arms (live + replay) — opacity at the ACP boundary is the adapter's
  choice, not missing data. [src: acp/session.py:203,292]
- kimi-code: the TS ACP adapter hardcodes
  `if (!isFromMainAgent(event)) return` at each event-class entry;
  upstream issue #2482 names this guard as dropping all non-main-agent
  events, and the fix PR #2484 was closed unmerged.
  [src: acp-adapter/src/session.ts:1024-1100]

That guard lives in the older `acp-adapter` package. In the current
kimi-code source (revision reviewed 2026-09-08), `packages/acp-server`
instead explicitly binds
`klient.session(sessionId).agent('main')` and subscribes there; the main-only
visibility remains. See the [current Kimi API page](../runtimes/kimi.md).

**Red line (attribution):** an adapter may degrade to opaque only when
the runtime truly lacks the information — never because the adapter
didn't wire it up. Every adapter must explicitly declare which tier of
the spectrum (#1/#2/#3) it carries, and that declaration must align with
what the runtime actually exposes. The ACP adapter must subscribe to the
vendor lifecycle notifications to discover child sessionIds and receive
those children's standard updates, attributing them per
[attribution.md](attribution.md) and
[session-graph-and-cursor.md](session-graph-and-cursor.md) — the old
filter's legitimate purpose (avoiding mis-mixing) is taken over by the
attribution dimension, not by discarding data.

**Red line (spanId):** `spanId` carries only runtime-native
turn/span identifiers (Codex app-server's `turn.id` / `turnId`, Kimi's turn id, …); if the
runtime provides none, it is honestly absent. oar never generates a
`spanId` — otherwise the deleted synthesized turn boundaries return
through this field.

## Hard spot 1: cross-agent turnId / toolCallId collisions

Each agent generates its own IDs; flattened into one stream they are not
naturally unique (the real difficulty in PR #2484's review). → Attribution
is not a decorative field for UIs — it is the precondition of ID
uniqueness: the identity of a tool call or turn must be the composite key
`(agentPath, id)`, and a bare `toolCallId` must never be treated as a
global key (Example 4 in [attribution.md](attribution.md)). ACP draft
PR #855's child-session approach solves the same problem a different way:
a new session is a new ID namespace. [src]

## Hard spot 2: background children outlive the parent turn

kimi-code has `runInBackground`; kimi-cli's `ApprovalRequest.source_kind`
directly distinguishes `foreground_turn` / `background_agent`. → A
child's lifecycle must not hang off the parent turn: a turn ending must
not implicitly close its derived agents, and cursor/completion converge
per agent (`agentPath`) — otherwise a background child's tail events are
either lost or misattributed to the next turn.
[src: wire/types.py:308-325]

### Example 8 · Background sub-agent: parent turn ends, child stream continues

```
seq=120  ✓ event  root           result {…}
         ↳ the parent turn's completion event has arrived
seq=121  ✓ event  path=["bg-7"]  tool_result {…}
seq=122  ✓ event  path=["bg-7"]  completed {usage:…}
         ↳ the background child is still alive; records keep entering the
           stream, correctly attributed; a settled-gate would swallow
           121 and 122 here
```

## Boundaries and open evidence points

- Not in this protocol: usage *derivation* (cumulative/epoch/boundary
  views), storage, and query read-models — all consumer business.
- Still resting on [sym]+[doc] evidence: a live capture of claude's
  stream-json interleaving under concurrent sub-agents. It can be
  upgraded to live-source evidence at any time by running a real `Task`
  capture; deliberately deferred for now because it costs subscription
  quota.
- Still resting on [sym] evidence: grok's vendor lifecycle notifications
  on a live wire. No live check has run — the probe machine has no grok
  credentials; the names were re-confirmed in the grok 1.0.25 binary.
- codex child-thread delivery and identity are [env]
  on codex 0.149.0 (three runs, experiments/codex-child-threads.ts). The
  child's `turn/completed` can arrive before the root's, which is why the
  Session folds scope to the root session (record-stream.md).
