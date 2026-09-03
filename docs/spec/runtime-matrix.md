# Runtime matrix, adapter red lines, and the two hard spots

> Part of the [v2 spec, draft v0.8](README.md). Related design pages:
> [hard problems 9–10](../design/hard-problems.md#attribution--the-most-underestimated-part),
> [foundations](../design/foundations.md).

## Per-runtime landing matrix

How each shipped runtime maps onto the contract:

| runtime | sub-agent exposure | linkage | per-agent tokens | session graph | resume | evidence |
|---|---|---|---|---|---|---|
| claude | yes (`Task`), flattened into one stream | `parent_tool_use_id` | `subagent_tokens` | `agentPath` (not in graph) | session id | [sym][v1][env] |
| codex | yes, flattened into one stream | `parent_tool_use_id` | `subagent_tokens` | `agentPath` (not in graph) | session id / `expectedTurnId` | [sym][v1][env] |
| pi | no native (host composes) | host-nested sessions | flat (host splits) | fork edges (in graph) | session id | [src][v1] |
| grok (ACP) | nested sessions (#3), same connection | child has its own ACP sessionId | per-child usage (multiple views; adapter dedups) | parent→child session edges (in graph) | agent_id / session | [src] |
| kimi (ACP) | opaque (#1): default subscribes main agent only | root `Agent` tool card only | no typed child usage exposed | nothing fabricated from display text | agent_id | [src] |
| kimi-cli (native wire) | wrapper records (#2): `SubagentEvent`, one stream | `parent_tool_call_id` + `agent_id` + `subagent_type` | child events self-attribute | `agentPath`, recursive (not in graph) | session / agent_id | [src] |
| kimi-code (native KAP) | agent graph (#2): key = `(session_id, agent_id)` | `subagentId` + `parentAgentId` + `parentToolCallId` + `runInBackground` | `subagent.completed` carries usage | `agentPath` (not in graph) | session / agent_id | [src] |

The #1/#2/#3 tiers are the attribution spectrum defined in
[attribution.md](attribution.md).

## Adapter red lines

**Why:** "the adapter drops attribution" appears in identical form in
three mutually independent codebases, and upstream has confirmed it
itself. When the protocol lacks the attribution dimension, this is the
adapter's *inevitable* degeneration path — not three accidental
oversights.

- OAR v1: the shared ACP adapter's entry filter
  `if (method !== "session/update" || params.sessionId !== opened.sessionId) return;`
  throws away all of grok's child data — grok is artificially made
  opaque. [v1: shared/acp/session.ts:97-116]
- kimi-cli: its own ACP adapter has two `case SubagentEvent(): pass`
  arms (live + replay) — opacity at the ACP boundary is the adapter's
  choice, not missing data. [src: acp/session.py:203,292]
- kimi-code: the TS ACP adapter hardcodes
  `if (!isFromMainAgent(event)) return` at each event-class entry;
  upstream issue #2482 names this guard as dropping all non-main-agent
  events, and the fix PR #2484 was closed unmerged.
  [src: acp-adapter/src/session.ts:1024-1100]

**Red line (attribution):** an adapter may degrade to opaque only when
the runtime truly lacks the information — never because the adapter
didn't wire it up. Every adapter must explicitly declare which tier of
the spectrum (#1/#2/#3) it carries, and that declaration must align with
what the runtime actually exposes. v2's ACP adapter must subscribe to the
vendor lifecycle notifications to discover child sessionIds and receive
those children's standard updates, attributing them per
[attribution.md](attribution.md) and
[session-graph-and-cursor.md](session-graph-and-cursor.md) — the old
filter's legitimate purpose (avoiding mis-mixing) is taken over by the
attribution dimension, not by discarding data.

**Red line (spanId, new in v0.8):** `spanId` carries only runtime-native
turn/span identifiers (codex's `turn_context`, kimi's turn id, …); if the
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
           stream, correctly attributed. v1's isSettled gate would swallow
           121 and 122 here
```

## Boundaries and one open evidence point

- Not in this protocol: usage *derivation* (cumulative/epoch/boundary
  views), storage, and query read-models — all consumer business.
- The one point still resting on [sym]+[doc] evidence: a live capture of
  claude's stream-json interleaving under concurrent sub-agents. It can
  be upgraded to live-source evidence at any time by running a real
  `Task` capture; deliberately deferred for now because it costs
  subscription quota.
