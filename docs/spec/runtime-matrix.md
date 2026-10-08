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
| opencode (ACP) | `opaque` | `opencode acp` forwards only its own sessions' parts; a `task` subagent runs in a child session whose frames never reach the transport, so only the parent's tool call shows ([src] opencode 1.18.34 `acp/event.ts`) |

| runtime | sub-agent exposure | linkage | per-agent tokens | session graph | resume | evidence |
|---|---|---|---|---|---|---|
| claude | native subagent messages can share the stream | `parent_tool_use_id` | current transport's child usage attribution unverified | `agentPath` (not in graph) | native session id | [native/current mapping](../runtimes/claude.md) |
| codex (app-server) | native child threads and collaboration items on the parent's connection | `senderThreadId` / `receiverThreadIds`; `subAgentActivity.agentThreadId` ([env]: `started` on the root names the child, `interacted` on the child names the root) | both threads report their own running total in `thread/tokenUsage/updated`; the child's is in its own session's records, not in the root `usage()` ([env]); the root's counts from when the Session opened ([#169](attribution.md#usage-one-constraint)) | native thread topology; child threads are child sessions | `threadId`; `expectedTurnId` is a steer precondition | [pinned schema/current mapping](../runtimes/codex.md) |
| pi | no native (host composes) | host-nested sessions | flat (host splits) | no runtime-reported edges | session id | [src] |
| cursor (`@cursor/sdk`) | wrapper records (#2) in the parent run's updates | the `task` call id on `tool-call-delta` | each run's `turn-ended` usage is the root's; none seen for a child ([env]) | `agentPath` (not in graph) | `agentId` | [native/current mapping](../runtimes/cursor.md) |
| grok (ACP) | nested sessions (#3), same connection | child has its own ACP sessionId | child usage lands in the child session's records ([src]; live unverified) | parent→child session edges (in graph, [sym]) | ACP `sessionId` | [native/current mapping](../runtimes/grok.md) |
| antigravity (ACP) | opaque (#1): child activity flattened onto the parent session | `start_subagent` tool card only; child id only as a `toolCallId` prefix | no usage reported for any session ([env]) | nothing fabricated | ACP `sessionId` | [native/current mapping](../runtimes/antigravity.md) |
| kimi (ACP) | opaque (#1): default subscribes main agent only | root `Agent` tool card only | no typed child usage exposed | nothing fabricated from display text | ACP `sessionId` | [native/current mapping](../runtimes/kimi.md) |
| opencode (ACP) | opaque (#1): child sessions not forwarded | root `task` tool card only | no child usage exposed | nothing fabricated | ACP `sessionId` (opencode `ses_` id) | [native/current mapping](../runtimes/opencode.md) |
| kimi-cli (native wire) | wrapper records (#2): `SubagentEvent`, one stream | `parent_tool_call_id` + `agent_id` + `subagent_type` | child events self-attribute | `agentPath`, recursive (not in graph) | session / agent_id | [src] |
| kimi-code (native KAP) | agent graph (#2): key = `(session_id, agent_id)` | `subagentId` + `parentAgentId` + `parentToolCallId` + `runInBackground` | `subagent.completed` carries usage | `agentPath` (not in graph) | session / agent_id | [src] |

## Session controls

`prompt`, `queue` and `abort` are on every session. `steer` and `withdraw`
are members a session may lack: a control the runtime cannot do is an
absent member, never a request that is always rejected
([record stream](record-stream.md#the-rules)). Where `queue.durable` is
false, the adapter holds queued input in this process.

| runtime | `steer` | `withdraw` | `capabilities.queue.durable` |
|---|---|---|---|
| claude | yes: a user message written to stdin mid-turn | yes | no |
| codex | yes: `turn/steer` with `expectedTurnId` | no: the queue is codex's own (`thread/queue/add`; [why](record-stream.md#withdrawing-held-input)) | yes |
| pi | yes: the SDK session's `steer` | yes | no |
| cursor (`@cursor/sdk`) | yes, text only: `run.steer` (images are rejected `unsupported`) | yes | no |
| grok (ACP) | yes: a prompt RPC with `_meta.sendNow` | yes | no |
| kimi (ACP) | no | yes | no |
| antigravity (ACP) | no | yes | no |
| opencode (ACP) | yes: a plain prompt RPC mid-turn, which joins the running loop at its next step; both prompts are answered at idle | yes | no |

## Tool outcomes

Native sources for the `tool_call_ended` fields (the rule that they are
never derived is in [record-stream.md](record-stream.md#the-rules)):

| runtime | `content` from | `result` from | `exitCode` from |
|---|---|---|---|
| claude | `tool_result.content` (a string or blocks) | stream-json `tool_result.is_error`, optional and false by default in the Messages API, so an absent field is `ok` ([src]; 2.1.288 omits it on successful Read, Write and Edit) | none (`tool_use_result` carries no exit status) |
| codex | `commandExecution.aggregatedOutput`; an MCP call's result blocks (an error as its message); `webSearch` results as one `other` part; else the item's status word | `item/completed.status` `completed`/`failed` ([src]) | `commandExecution` items' `exitCode` ([src]) |
| pi | `tool_execution_end.result.content` blocks, else the whole result | `tool_execution_end.isError` false/true ([src]) | none |
| grok, kimi, antigravity, opencode (ACP) | the closing `tool_call_update.content` blocks, else `rawOutput`; text parts are cut at 10,000 characters (`native` keeps them whole) | `tool_call_update.status` `completed`/`failed` ([src]) | `rawOutput.exit_code` on the closing `tool_call_update`: grok ([src] grok 1.0.25), antigravity ([env] agy_acp_server 1.2.1) |
| cursor (`@cursor/sdk`) | a shell call's stdout and stderr (one empty text part when it printed nothing), a read's file text, an edit's or write's diff, an error's message, else one `other` part ([env] SDK 1.0.35) | `tool-call-completed` `toolCall.result.status` `success`/`error` ([env] SDK 1.0.35) | a shell call's `result.value.exitCode`, `null` when `signal` names one ([env]) |

A frame without the corresponding native field leaves the key absent; the
native frame stays verbatim beside the event.

## Session environment

`SessionOptions.env` is a `Readonly<Record<string, string | null>>` overlay:
a string sets a variable (an empty string remains present), and `null`
removes it from the inherited environment. Omitted keys inherit unchanged;
OAR never changes the host's `process.env`. Windows names are matched without
regard to case. For example, `env: { ANTHROPIC_API_KEY: null,
ANTHROPIC_BASE_URL: "https://provider.example" }` removes an inherited key
while selecting the session's provider endpoint.

Claude, codex, grok, kimi, opencode and antigravity apply the overlay to their
runtime process and its tool children; ACP client-hosted terminals receive it
too. OpenCode's prompt preparation queries use the same environment. Pi
applies it to its Bash tool's children, not its in-process provider. Cursor
refuses any non-empty `env`, including a removal-only map. Native tool shells
or runtime configuration can subsequently set their own variables.

An MCP server's own `env` remains a map of strings; `null` there is refused
with `UnsupportedOptionError` on `mcpServers`. Pi also refuses an `env`
removal combined with any stdio `mcpServers`: its native MCP transport
re-inherits the host environment and cannot remove a variable. HTTP-only
servers do not impose this restriction. The refusal is conditional and does
not add `env` to pi's always-refused options.

Session environment options, including removed keys, are not written to the
record stream or voyage header. Runtime-specific removals stay in OAR:
Claude's `CLAUDECODE` marker is always removed. Child-process and native Pi
Bash regressions: [session-env.test.ts](../../tests/session-env.test.ts),
[pi-env.test.ts](../../tests/providers/pi-env.test.ts).

## Refused session options

What a runtime cannot honor is refused, never dropped: `session()` rejects
with an `UnsupportedOptionError` whose `option` names the refused
`SessionOptions` key and whose message is the reason, rather than open a
session that quietly runs without it. A host may simply try and fall back
on that error, and tells it from a failed login or a network error without
reading the message.

`Runtime.refusedSessionOptions` declares, before any session opens, the
`SessionOptions` a runtime refuses when given (`env`, `mcpServers`: a
non-empty one), each with that reason. The adapter checks the same map, so
the declaration and the refusal cannot drift
(`tests/refused-session-options.test.ts`). A host leaves a declared option
out instead of naming runtimes.

| runtime | refuses | why |
|---|---|---|
| cursor | `systemPrompt`, `appendSystemPrompt`, `env`, `mcpServers` | the SDK's local agent fails a run given a system prompt and has no append; it runs in the host process with no environment of its own for tools; its agent runs on Cursor's servers, and no run without a login or paid tokens shows it calling a tool of `Agent.create`'s `mcpServers` ([cursor](../runtimes/cursor.md#session-mcp-servers)) |
| kimi | `systemPrompt`, `appendSystemPrompt` | `kimi acp` has no per-session prompt input; its launcher does not forward the CLI's agent-profile flags ([audit](../runtimes/kimi.md#models-instructions-and-context)) |
| antigravity | `systemPrompt`, `appendSystemPrompt` | the selected server has no prompt input in its protocol, launcher or configuration ([audit](../runtimes/antigravity.md#models-instructions-and-context)) |
| claude, codex, grok, opencode, pi | nothing | |

`mcpServers` is refused until a runtime's channel is shown to make its agent
call an attached server's tool, with the evidence on its runtime page
([#170](https://github.com/botiverse/oar/issues/170)). Where it is taken:

| runtime | channel | stdio | http | resume | a name the user's config also has |
|---|---|---|---|---|---|
| claude | `--mcp-config <path>`: a 0600 FIFO removed once claude has read it (a 0600 file removed when the process ends on Windows); no `--strict-mcp-config` | yes | yes | the flag again | the session's server replaces the user's for that process ([claude](../runtimes/claude.md#session-mcp-servers)) |
| codex | `config.mcp_servers` on `thread/start` and `thread/resume` | yes | yes | the override again | merged into the user's entry field by field; oar's `command` / `url`, `args` and `enabled = true` win ([codex](../runtimes/codex.md#session-mcp-servers)) |
| grok | ACP `mcpServers` on `session/new` and `session/resume`; the model reaches the tools through grok's `use_tool` | yes | yes | the param again | the session's replaces the user's `config.toml` entry; the user's others stay ([grok](../runtimes/grok.md#session-mcp-servers)) |
| kimi | ACP `mcpServers` on `session/new` and `session/resume` | yes | yes | the param again | the session's replaces the user's `mcp.json` entry; the user's others stay ([kimi](../runtimes/kimi.md#session-mcp-servers)) |
| opencode | ACP `mcpServers` on `session/new` and `session/resume`, held by that opencode process | yes | yes | the param again | the session's replaces the user's `mcp` entry for that process (a session server that fails to start removes it); the user's others stay ([opencode](../runtimes/opencode.md#session-mcp-servers)) |
| antigravity | ACP `mcpServers` on `session/new` and `session/resume`, started at the first prompt; the model calls them through `call_mcp_tool`. An entry with `env` or `headers` is refused: the server would store their values in plain text in its conversation database | yes | yes | the param again | the session's replaces the user's `mcp_config.json` entry; the user's others stay ([antigravity](../runtimes/antigravity.md#session-mcp-servers)) |
| pi | pi's MCP extension plus one registering the entries (`pi.registerMcpServer`); tools declared directly | yes | yes | registered again | oar's pi loads no `mcp.json`; a name another extension registered fails the open ([pi](../runtimes/pi.md#session-mcp-servers)) |

Evidence: the vendor tests run the real CLI (pi: the bundled SDK) against a
scripted provider whose model calls a stdio and an http echo server's tool, on
open and on a resume in a new process, and assert the provider received what
only that server writes, carrying the credential the entry gave it:
[`mcp-servers.vendor.test.ts`](../../sea-trial/vendor/mcp-servers.vendor.test.ts)
(claude, codex), [`mcp-servers-pi.vendor.test.ts`](../../sea-trial/vendor/mcp-servers-pi.vendor.test.ts)
and [`mcp-servers-acp.vendor.test.ts`](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts)
(grok, kimi, opencode, antigravity: each CLI pointed at aimock from a fresh
home, [harness](../../sea-trial/harness/aimock-acp.ts); run locally, as CI
has no ACP aimock backend). The same tests cover the name clash and check that
no record holds a credential. The recordings are
`tests/replay/fixtures/{claude,codex,pi}-mcp-echo.raw.jsonl`. A list naming a
server twice, or with an empty name, is a plain error before anything starts,
as is a name codex (`^[\w:@/.-]+$`) or pi (`^[\w-]+$`, and two names pi folds
into one tool namespace) would not take. A transport a runtime cannot attach
is an `UnsupportedOptionError` on `mcpServers`: an http entry on an ACP agent
whose `initialize` declares no `mcpCapabilities.http`; every runtime above
attaches both. So is an entry with a non-empty `env` or `headers` on
antigravity, which would write them to its disk: a conditional refusal, not
an always-refused option declaration.

OpenCode carries prompt options through native inline configuration. An
already-defined `OPENCODE_CONFIG_CONTENT` refuses either prompt option, and
an empty replacement is refused because native OpenCode selects its built-in
prompt for that value ([evidence](../runtimes/opencode.md#models-effort-instructions-and-context)).
These are conditional refusals, not always-refused option declarations.

Grok refuses an append-only prompt change on resume: native `rules` is not
reapplied. A `systemPrompt`, with or without `appendSystemPrompt`, is supported
on resume ([request evidence](../runtimes/grok.md#models-and-instructions)).
This conditional refusal is not an always-refused option declaration.

Kimi and opencode also refuse a `resume` that names another directory than
the one their `session/list` says the session lives in (option `cwd`): they
would run the session in its own directory instead. Only the runtime knows the
session's directory, so this refusal is not declared up front; it is the
same error ([resume in another directory](../runtimes/resume-cwd.md)).

An ACP runtime whose session advertises no `thought_level` config option
has no effort channel, so it refuses `effort` with the same error once its
handshake shows that (antigravity, [env] agy_acp_server 1.2.1;
`shared/acp/effort.ts`, `tests/acp/acp-session-antigravity.test.ts`). The
menu belongs to the model in effect: opencode offers one only for a model
with variants, so after a requested model switch the switch's answer is
read, not the open's ([env] opencode 1.18.30). A
level a runtime does not offer is a plain error naming the level, not this
one.

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
  views), storage ([decision](../design/decisions.md#a-storage-layer-2026-09-03)),
  and query read-models, all consumer business.
- claude's stream-json interleaving under concurrent sub-agents rests on
  [sym]+[doc] evidence; a live `Task` capture would upgrade it and is
  deferred because it costs subscription quota.
- grok's vendor lifecycle notifications rest on [sym] evidence: names
  re-confirmed in the grok 1.0.25 binary, no live check (the probe machine
  has no grok credentials).
- codex child-thread delivery and identity are [env] on codex 0.149.0
  (three runs, experiments/codex-child-threads.ts); the child's
  `turn/completed` can arrive before the root's.
