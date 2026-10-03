# Runtime matrix, adapter red lines, and the two hard spots

> Part of the [record-stream spec](README.md). Related design pages:
> [hard problems 9-10](../design/hard-problems.md#attribution-the-most-underestimated-part),
> [foundations](../design/foundations.md).

## Per-runtime landing matrix

The **declared tier** column is what each adapter's
`capabilities.attribution` reports; the other columns are native evidence.
The #1/#2/#3 tiers are the attribution spectrum defined in
[attribution.md](attribution.md). The
[runtime programming-interface pages](../runtimes/README.md) hold current
calls, resume semantics, and what each adapter still does not carry.

| runtime | declared tier | how children appear in the stream |
|---|---|---|
| claude | `attributed` | frames with `parent_tool_use_id` carry `agentPath = [...parentPath, taskCallId]`, nested through the Task call's own agent; child usage stays unattributed (unverified) |
| codex (app-server) | `nested` | notifications for other thread ids are child-session records (`sessionId` = the thread); a collab item naming the child adds a `tool_call` edge (`subAgentActivity.agentThreadId`). [env] codex 0.149.0: child-thread notifications arrive on the parent's connection (experiments/codex-child-threads.ts) |
| pi | `none` | pi has no native sub-agents; `agentPath` is always root |
| cursor (`@cursor/sdk`) | `attributed` | a child's updates arrive inside the parent's `task` call as `tool-call-delta {callId, taskUpdate}` and carry `agentPath = [...parentPath, taskCallId]` ([env] SDK 1.0.35) |
| grok (ACP) | `nested` | `session/update` for other session ids are child-session records; vendor lifecycle notifications add edges when they name a parent ([sym], unverified live; see [open evidence](#boundaries-and-open-evidence-points)) |
| antigravity (ACP) | `opaque` | the `start_subagent` tool call completes at once; the child's tool calls and text then arrive under the parent's session id (the child's own id survives only as the `toolCallId` prefix), so everything lands on root and nothing is fabricated ([env] agy_acp_server 1.2.1) |
| kimi (ACP) | `opaque` | `kimi acp` subscribes to the main agent only; the adapter records what arrives and fabricates nothing |

| runtime | sub-agent exposure | linkage | per-agent tokens | session graph | resume | evidence |
|---|---|---|---|---|---|---|
| claude | native subagent messages can share the stream | `parent_tool_use_id` | current transport's child usage attribution unverified | `agentPath` (not in graph) | native session id | [native/current mapping](../runtimes/claude.md) |
| codex (app-server) | native child threads and collaboration items on the parent's connection | `senderThreadId` / `receiverThreadIds`; `subAgentActivity.agentThreadId` ([env]: `started` on the root names the child, `interacted` on the child names the root) | both threads report cumulative `thread/tokenUsage/updated`; the child's is in its own session's records, not in the root `usage()` ([env]) | native thread topology; child threads are child sessions | `threadId`; `expectedTurnId` is a steer precondition | [pinned schema/current mapping](../runtimes/codex.md) |
| pi | no native (host composes) | host-nested sessions | flat (host splits) | no runtime-reported edges | session id | [src] |
| cursor (`@cursor/sdk`) | wrapper records (#2) in the parent run's updates | the `task` call id on `tool-call-delta` | each run's `turn-ended` usage is the root's; none seen for a child ([env]) | `agentPath` (not in graph) | `agentId` | [native/current mapping](../runtimes/cursor.md) |
| grok (ACP) | nested sessions (#3), same connection | child has its own ACP sessionId | child usage lands in the child session's records ([src]; live unverified) | parent→child session edges (in graph, [sym]) | ACP `sessionId` | [native/current mapping](../runtimes/grok.md) |
| antigravity (ACP) | opaque (#1): child activity flattened onto the parent session | `start_subagent` tool card only; child id only as a `toolCallId` prefix | no usage reported for any session ([env]) | nothing fabricated | ACP `sessionId` | [native/current mapping](../runtimes/antigravity.md) |
| kimi (ACP) | opaque (#1): default subscribes main agent only | root `Agent` tool card only | no typed child usage exposed | nothing fabricated from display text | ACP `sessionId` | [native/current mapping](../runtimes/kimi.md) |
| kimi-cli (native wire) | wrapper records (#2): `SubagentEvent`, one stream | `parent_tool_call_id` + `agent_id` + `subagent_type` | child events self-attribute | `agentPath`, recursive (not in graph) | session / agent_id | [src] |
| kimi-code (native KAP) | agent graph (#2): key = `(session_id, agent_id)` | `subagentId` + `parentAgentId` + `parentToolCallId` + `runInBackground` | `subagent.completed` carries usage | `agentPath` (not in graph) | session / agent_id | [src] |

## Tool outcomes

Native sources for the `tool_call_ended` fields (the rule that they are
never derived is in [record-stream.md](record-stream.md#the-rules)):

| runtime | `result` from | `exitCode` from |
|---|---|---|
| claude | stream-json `tool_result.is_error`, optional and false by default in the Messages API, so an absent field is `ok` ([src]; 2.1.288 omits it on successful Read, Write and Edit) | none (`tool_use_result` carries no exit status) |
| codex | `item/completed.status` `completed`/`failed` ([src]) | `commandExecution` items' `exitCode` ([src]) |
| pi | `tool_execution_end.isError` false/true ([src]) | none |
| grok, kimi (ACP) | `tool_call_update.status` `completed`/`failed` ([src]) | grok: `rawOutput.exit_code` on the closing `tool_call_update` ([src] grok 1.0.25) |
| cursor (`@cursor/sdk`) | `tool-call-completed` `toolCall.result.status` `success`/`error` ([env] SDK 1.0.35) | a shell call's `result.value.exitCode`, `null` when `signal` names one ([env]) |

A frame without the corresponding native field leaves the key absent; the
native frame stays verbatim beside the event.

## Refused session options

What a runtime cannot honor is refused, never dropped: `session()` rejects
with an `UnsupportedOptionError` whose `option` names the refused
`SessionOptions` key and whose message is the reason, rather than open a
session that quietly runs without it. A host may simply try and fall back
on that error, and tells it from a failed login or a network error without
reading the message.

`Runtime.refusedSessionOptions` declares, before any session opens, the
`SessionOptions` a runtime refuses when given (`env`: a non-empty one), each
with that reason. The adapter checks the same map, so the declaration and
the refusal cannot drift (`tests/refused-session-options.test.ts`). A host
leaves a declared option out instead of naming runtimes.

| runtime | refuses | why |
|---|---|---|
| cursor | `systemPrompt`, `appendSystemPrompt`, `env` | the SDK's local agent fails a run given a system prompt and has no append; it runs in the host process with no environment of its own for tools ([cursor](../runtimes/cursor.md)) |
| kimi, antigravity | `systemPrompt`, `appendSystemPrompt` | their ACP surfaces expose no system prompt override |
| claude, codex, grok, pi | nothing | |

Kimi also refuses a `resume` that names another directory than the one
its `session/list` says the session lives in (option `cwd`): kimi would run
the session in its own directory instead. Only the runtime knows the
session's directory, so this refusal is not declared up front; it is the
same error ([resume in another directory](../runtimes/resume-cwd.md)).

## Adapter red lines

"The adapter drops attribution" appears in identical form in mutually
independent codebases, and upstream has confirmed it. When the protocol
lacks the attribution dimension, this is the adapter's *inevitable*
degeneration path, not an accidental oversight. A session-id entry filter
(`if (params.sessionId !== opened.sessionId) return;`) is its canonical
shape: it throws away every child session's data and makes a nested
runtime artificially opaque.

- kimi-cli: its own ACP adapter has two `case SubagentEvent(): pass` arms
  (live + replay): opacity at the ACP boundary is the adapter's choice, not
  missing data. [src: acp/session.py:203,292]
- kimi-code: the older TS `acp-adapter` package hardcodes
  `if (!isFromMainAgent(event)) return` at each event-class entry; upstream
  issue #2482 names this guard as dropping all non-main-agent events, and
  the fix PR #2484 was closed unmerged.
  [src: acp-adapter/src/session.ts:1024-1100]
  The current source (reviewed 2026-09-08) has `packages/acp-server` bind
  `klient.session(sessionId).agent('main')` and subscribe there, so
  main-only visibility remains. See the
  [current Kimi API page](../runtimes/kimi.md).

**Red line (attribution):** an adapter may degrade to opaque only when the
runtime truly lacks the information, never because the adapter didn't wire
it up. Every adapter must explicitly declare which tier of the spectrum
(#1/#2/#3) it carries, and that declaration must align with what the
runtime actually exposes. The ACP adapter must subscribe to the vendor
lifecycle notifications to discover child sessionIds and receive those
children's standard updates, attributing them per
[attribution.md](attribution.md) and
[session-graph-and-cursor.md](session-graph-and-cursor.md): the
legitimate purpose of a session-id filter (avoiding mis-mixing) is served
by the attribution dimension, not by discarding data.

**Red line (spanId):** `spanId` carries only runtime-native turn/span
identifiers (Codex app-server's `turn.id` / `turnId`, Kimi's turn id, …);
if the runtime provides none, it is honestly absent. oar never generates a
`spanId`; otherwise synthesized turn boundaries would return through this
field.

## Hard spot 1: cross-agent turnId / toolCallId collisions

Each agent generates its own IDs; flattened into one stream they are not
naturally unique (the real difficulty in PR #2484's review). Attribution is
therefore the precondition of ID uniqueness, not a decorative UI field: the
identity of a tool call or turn must be the composite key
`(agentPath, id)`, and a bare `toolCallId` must never be treated as a
global key (Example 4 in [attribution.md](attribution.md)). ACP draft
PR #855's child-session approach solves the same problem another way: a
new session is a new ID namespace. [src]

## Hard spot 2: background children outlive the parent turn

kimi-code has `runInBackground`; kimi-cli's `ApprovalRequest.source_kind`
directly distinguishes `foreground_turn` / `background_agent`. A child's
lifecycle must not hang off the parent turn: a turn ending must not
implicitly close its derived agents, and cursor/completion converge per
agent (`agentPath`); otherwise a background child's tail events are either
lost or misattributed to the next turn. [src: wire/types.py:308-325]

### Example 8 · Background sub-agent: parent turn ends, child stream continues

```
seq=120  ✓ frame  root           result {…}
         ↳ the parent turn's completion event has arrived
seq=121  ✓ frame  path=["bg-7"]  tool_result {…}
seq=122  ✓ frame  path=["bg-7"]  completed {usage:…}
         ↳ the background child is still alive; records keep entering the
           stream, correctly attributed; a settled-gate would swallow
           121 and 122 here
```

## Boundaries and open evidence points

- Not in this protocol: usage *derivation* (cumulative/epoch/boundary
  views), storage, and query read-models, all consumer business.
- claude's stream-json interleaving under concurrent sub-agents rests on
  [sym]+[doc] evidence; a live `Task` capture would upgrade it and is
  deferred because it costs subscription quota.
- grok's vendor lifecycle notifications rest on [sym] evidence: names
  re-confirmed in the grok 1.0.25 binary, no live check (the probe machine
  has no grok credentials).
- codex child-thread delivery and identity are [env] on codex 0.149.0
  (three runs, experiments/codex-child-threads.ts); the child's
  `turn/completed` can arrive before the root's.
