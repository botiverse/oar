# Kimi runtime

Evidence baseline: reviewed 2026-09-08 against
[`kimi-code` `f9ca33376`](https://github.com/MoonshotAI/kimi-code/tree/f9ca33376)
(0.41.0 source, recorded in [OAR's experiments](../../experiments/README.md)).
The [wire snapshot](../../tests/replay/fixtures/kimi-acp-v1.vendor.json) is
**0.38.0, 2026-08-26**; the adapter experiment records 2026-08-27.
Newer-source behavior was inspected, not exercised on a live binary. No model
calls or tests ran for this review. The [v2 spec](../spec/README.md) is not
current OAR behavior.

## Native concepts and calling interfaces

This page concerns the TypeScript **MoonshotAI/kimi-code** harness. The
separate [Python kimi-cli](https://github.com/MoonshotAI/kimi-cli) is not
interchangeable evidence despite overlapping command and product names.

A native session is a persistent workspace/conversation container. Inside it,
agents have their own context, turns, tool calls, and event scopes. Session
identity, agent identity, numeric turn IDs, and prompt IDs have distinct
roles. Children are native agents with their own lifecycle, including
background execution.

Kimi offers a terminal application and several programmatic surfaces: the
Node SDK (`KimiHarness`/`Session`), native KAP/klient services, and `kimi acp`
for ACP JSON-RPC over stdio. These interfaces expose different subsets.
The [Node Session](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/node-sdk/src/session.ts#L140-L200)
has prompt/steer methods and approval/question handlers. Native
[agent services](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/klient/src/contract/agent/services.ts#L28-L55)
separate submission from cancellation. ACP instead binds
[`klient.session(sessionId).agent('main')`](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/session.ts#L249-L344)
and translates that agent's event stream. One ACP session therefore does not
expose every agent in the native session.

## High-level mapping to OAR

OAR v2 (2026-09-11) exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as an event's `native`; the cross-runtime `views` are what
OAR read out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `kimi-code` executable | One `kimi acp` subprocess per OAR Session; its exit is an `exited` response record. |
| Persistent native session | `Session.id` preserves its ID; `SessionOptions.resume` uses ACP attachment with a fresh stream (seq 0; no history rebuild). |
| Handshake answers | `initialize`, `authenticate`, `session/new`/`resume`/`load`, `session/set_model` answers are event records with a `model` view where they report one; the `config_option_update` pushed while opening is recorded too, so `Session.model()` folds to it. |
| Native agent and turn | Only ACP's `main` agent reaches this transport; every `session/update` is one event with `native` verbatim. No `spanId` (ACP updates carry no turn id). Attribution tier declared `opaque`. |
| Prompt, steer, and delivery services | `prompt()` is a `toRuntime` request answered accepted/`busy`; the `session/prompt` answer is an event with the `turn_ended` view. Steer is always `rejected not_steerable` (no ACP method); `queue()` is a host-memory FIFO, `durable: false`. |
| Typed events, history, and child graph | Views for message/thought/tool/usage/model updates; unknown kinds recorded with no views. Child agents never appear on this transport, so the graph holds the root only. |
| Client execution and interaction duties | Every reverse request (permission, terminal) is a `toApp` request record and OAR's fixed-policy answer the `answered` response. |

See the [Kimi profile](../../packages/oar/src/runtimes/kimi/session.ts),
[ACP opening path](../../packages/oar/src/shared/acp/profile.ts),
[session controller](../../packages/oar/src/shared/acp/session.ts),
[record placement](../../packages/oar/src/shared/acp/records.ts),
[turn machinery](../../packages/oar/src/shared/acp/turns.ts), and
[view projection](../../packages/oar/src/shared/acp/projection.ts), alongside
the [native ACP reference](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/docs/en/reference/kimi-acp.md).
“Unexposed” means OAR has no mapping; “transport-limited” means the selected
native boundary already loses the capability; “unverified” means evidence
is missing.

## Capability details

### Starting, authenticating, and creating a session

Native ACP requires `initialize` with the protocol version and client
capabilities. `authenticate { methodId: "login" }` validates readiness rather
than starting login. At this source version, the
[auth gate](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/server.ts#L626-L645)
accepts engine-ready credentials, with an OAuth-summary fallback.
`session/new { cwd, mcpServers, additionalDirectories? }` returns an
engine-generated `sessionId`, `configOptions`, and `modes`.

OAR launches `kimi acp`, selects advertised `login`, and uses 30-second
opening deadlines. [Installation detection](../../packages/oar/src/runtimes/kimi/installation.ts)
probes `kimi acp --help` and includes `.kimi-code/bin/kimi` and legacy
`kimi-code` candidates; it does not prove compatibility with Python kimi-cli.
Credentials and persisted sessions must be accessible in the subprocess's
configured data root. Spawn/auth/creation failures reject session construction.

### Resuming, loading, listing, and forking

Native `session/resume { sessionId, cwd, mcpServers, additionalDirectories? }`
restores the existing session and returns `configOptions` and `modes`,
**without history replay**. `session/load` has the same request shape but
awaits ordered history `session/update` notifications before responding;
history is not a response messages array.

The [handlers](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/server.ts#L296-L322)
ignore `cwd`, warn and ignore `additionalDirectories`, and pass MCP settings
to restore. [Cold restore](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/server.ts#L533-L570)
can apply those ephemeral servers; already-live sessions pass through.
Unknown IDs return `invalid_params` (`-32602`); missing authentication returns
`auth_required` (`-32000`). Neither creates a substitute session.

With a previously probed available installation, OAR callers use:

```ts
const resumed = await kimiRuntime.session(installation, {
  cwd,
  resume: previousSessionId, // Exact earlier Session.id, not an agent/turn ID.
});
const next = resumed.prompt("Continue");
```

OAR selects resume when `agentCapabilities.sessionCapabilities.resume` is
`true` or an object; otherwise load when `loadSession === true`, otherwise
rejects. It does not retry failed resume as load. It passes `mcpServers: []`,
applies a requested model after attachment, and selects yolo mode when
advertised. Success returns an OAR Session with the supplied native ID, no
restored Turn handle or transcript. History during opening is not retained.
Concurrent same-ID controllers and continuing in-flight work across OAR
subprocesses are unverified.

The Node SDK separately offers
[`harness.resumeSession({ id, includeSubagents?, replayTurnLimit?, ... })`](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/node-sdk/src/types.ts#L222-L237).
It returns a native Session and [reuses/coalesces facades](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/node-sdk/src/kimi-harness.ts#L166-L225)
for active or identical concurrent resumes inside that harness. Current ACP
uses `klient.session(id).restore()` and rebuilds its main-agent wrapper.
OAR neither exposes SDK replay options nor inherits its coalescing guarantee.
These are 0.41.0 source facts, not live claims about the 0.38.0 snapshot.

Native ACP also implements session list, delete, and fork. Current OAR exposes
none of those operations; resume is neither a session browser nor a fork API.

### Prompting, steering, queuing, and cancellation

Native `session/prompt { sessionId, prompt: [{ type: "text", text }] }`
streams updates and returns a `stopReason`. Attachment submits no prompt.
The native ACP driver buffers events arriving before the launch returns a
turn ID. It can bind a `session/cancel` request to that eventual ID.

OAR `prompt(string)` records a prompt request answered `accepted` once the
RPC is on the wire, or `rejected` (`busy`, or the transport error when the
process is gone). The RPC answer is recorded as event `session/prompt` with
the `turn_ended` view; an RPC error answer as `session/prompt/error` with a
failed end. Native SDK/agent services support steering, but the inspected
ACP method set has no steer operation; `steer()` is therefore always
`rejected not_steerable` and `capabilities.steer` is false. The queue is a
host-memory FIFO (`capabilities.queue.durable: false`), without a claim about
native queue durability; a drained input runs as a turn with an answer but
no prompt request of its own. `abort()` sends `session/cancel` and answers
`accepted`; if the cancelled prompt is not answered within ten seconds OAR
kills the process and the `exited` response is the turn's end. Background-
child effects are unverified.

Native ACP accepts image and resource blocks; OAR sends only one text block.
Audio is explicitly unsupported in the inspected ACP capability declaration.

### Outcomes and errors

Native ACP [maps most non-auth failures to `end_turn`](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/events-map.ts#L59-L74);
blocked/filtered cases become `refusal`, while auth failures use the RPC
error channel. OAR's `turn_ended` view maps every non-cancelled stop reason
to completed; the answer itself is in the event's `native`, so a consumer can
still read `refusal` or any other stop reason the runtime gave. This
separates loss before OAR receives a response (native) from OAR's reading
(the view).

### Events, history, and child agents

The [native child schema](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/protocol/src/events.ts#L878-L927)
contains `subagentId`, `parentToolCallId`, optional `parentAgentId`, and
`runInBackground`; completion can carry usage and context tokens. Current
ACP subscribes to `main`, so children never reach OAR — the adapter declares
attribution `opaque` and fabricates nothing. (OAR no longer filters by
session id; should a future `kimi acp` emit updates for other session ids,
they would be recorded as child-session records.) A root `Agent` tool card
is not a child trajectory. Earlier `acp-adapter` references to
`isFromMainAgent` describe older code; this baseline uses `acp-server` with
scoped subscriptions.

Every update is an event with `native` verbatim; views carry text,
reasoning, tool boundaries, context snapshots, and model reports. Native
`${turnId}:${toolCallId}` wire IDs survive as call IDs. Detail strings
truncate at 10,000 characters (`native` does not); tool progress/status
distinctions are in `native` only; a tool the runtime never ended gets no
synthetic end. The retained stream backs `subscribe(observer, cursor)` for
the life of the process; there is no native-history enumeration and no
rebuild after the process died.

### Models, thinking, modes, and instructions

Native ACP config options cover model, thinking, and mode, with
`session/set_model` retained as an extension. [OAR listing](../../packages/oar/src/runtimes/kimi/list-models.ts)
creates a temporary authenticated session and reads its model options;
thinking choices apply only to the current model. Open-time model selection
and early config-update readback are supported; public mid-session setters
are absent. OAR selects yolo through `session/set_mode` when advertised.

The OAR profile rejects `systemPrompt` and `appendSystemPrompt` because its
selected ACP integration exposes no override. This is not a claim that the
native harness cannot configure instructions.

### Context usage and compaction

Native ACP [emits context usage after the prompt response](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/session.ts#L907-L947)
and may omit it without a matching model size. OAR waits at most 500 ms,
then exposes the available snapshot; this is not a freshness guarantee.
Per-agent usage remains unexposed.

Native agent compaction exists; ACP
[`/compact` dispatches a background task](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/builtin-commands.ts#L100-L110).
OAR has no typed compact operation. Prompt text can reach that slash route,
but completion text emitted after the OAR Turn ends is dropped. Prompt
completion does not establish compaction completion.

### Tools, MCP, permissions, and questions

Native ACP accepts MCP configuration and supports filesystem, terminal, and
interaction reverse calls. Its permission channel handles tool approvals
and question fallback. OAR's [client](../../packages/oar/src/shared/acp/terminal.ts)
hosts terminals, disables client filesystem methods, and passes no MCP
servers. Vendor-configured tools can still run, but OAR has no per-session
MCP configuration or generic client-tool callback.

OAR uses yolo when available and automatically selects `allow_always`, then
`allow_once`, otherwise cancellation for reverse permission requests. Each
reverse request is recorded as a `toApp` request under the runtime's
JSON-RPC id and OAR's reply as the `answered` response, verbatim (terminal
output included). No caller decision channel exists, so approval and
question semantics cannot be represented as application interactions — the
stream shows what was asked and what OAR answered.

### Release and account usage

Native ACP close tears down a live session; delete is a separate operation.
OAR disposal cancels active work, attempts advertised session close, kills
its process, and disposes hosted terminals. It does not delete persisted
native sessions.

[OAR account usage](../../packages/oar/src/runtimes/kimi/account-usage.ts)
separately reads managed credentials and usage/profile endpoints. Account
quota and session context occupancy are distinct APIs; neither supplies the
missing child-agent usage stream.

## Tests and remaining evidence

[ACP tests](../../tests/acp/acp-session.test.ts) and
[model/usage tests](../../tests/acp/acp-session-model-usage.test.ts) use a fake
executable for the record skeleton, control accept/reject, early model
updates, and late/missing usage updates (the usage record is deliberately
held before the turn end).
[Snapshot tests](../../tests/acp/acp-vendor-snapshot.test.ts) bind assumptions
to recorded 0.38.0 schema. The [usage-order experiment](../../experiments/kimi-usage-update-order.ts)
separates fixture and live modes.

The [real-runtime CI matrix](../../.github/workflows/ci.yml) excludes Kimi.
Priority live probes are resume continuity, failure propagation, questions
and approvals, post-turn compaction, and native-versus-ACP child visibility.
Keep native API capabilities, transport limitations, OAR omissions, and
unexecuted checks separate when designing or claiming support.
