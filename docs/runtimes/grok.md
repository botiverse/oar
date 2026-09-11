# Grok runtime

Evidence baseline: reviewed 2026-09-08 against
[`grok-build` `bc7f02e`](https://github.com/xai-org/grok-build/tree/bc7f02e)
(Grok 1.0.12 source). The [wire snapshot](../../tests/replay/fixtures/grok-acp-v1.vendor.json)
is **Grok 1.0.5 (`5115b46bc9`), 2026-08-26**; the
[adapter experiment](../../experiments/acp-runtime.ts) records 2026-08-27.
Source-supported behavior below is not a live check of the newer binary.
No model calls or tests ran for this review. The [spec](../spec/README.md)
is not current OAR behavior.

## Native concepts and calling interfaces

Grok is a coding-agent harness. Its process owns sessions; each session owns
model context, configuration, incoming prompts, tool execution, and persistent
state. The ACP update log, model chat history, metadata, rewind points, and
compaction checkpoints serve different purposes. See the
[native session description](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/README.md#session-persistence).

The interactive TUI, headless `grok -p`, and `grok agent stdio` are calling
modes for that harness. OAR uses the last: ACP JSON-RPC over stdio, including
vendor extensions. ACP is bidirectional: Grok can ask its client to execute a
terminal command or decide a permission request while a prompt is running.

A native session ID identifies conversation continuity. A `promptId`, native
turn number, and JSON-RPC request ID have separate roles. Ordinary prompts
enter a delivery queue; `_meta.sendNow` selects immediate dispatch. Subagents
are independent child sessions with their own context, which may inherit
history/configuration, run in the background, and wake a parent. These native
concepts exist before OAR chooses its Session/Turn abstraction.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as an event's `native`; the cross-runtime `views` are what
OAR read out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| Grok executable/process | One subprocess per OAR Session, launched with noninteractive profile settings; its exit is an `exited` response record. |
| Persistent native session | `Session.id` preserves its ID; `SessionOptions.resume` attaches by that ID with a fresh stream (seq 0; no history rebuild). |
| Handshake answers | `initialize`, `authenticate`, `session/new`/`resume`/`load`, `session/set_model` answers are event records; the model they report is a `model` view, so `Session.model()` is a fold. |
| Prompt delivery and native execution | `prompt()` is a `toRuntime` request answered accepted/`busy`; each `session/prompt` RPC answer is an event, and the one closing the turn carries the `turn_ended` view (newest request's outcome). A steer adds another prompt RPC to the same turn. |
| `session/update` notifications | One event per notification, `native` verbatim, for EVERY session id; views for message/thought/tool/usage/model updates, none for unknown kinds — nothing is dropped. |
| Native child sessions | An update for another session id is a derived child-session record (its own `sessionId` on the envelope, a graph node). Vendor lifecycle notifications are subscribed by name and recorded verbatim; one naming a parent/child pair links the graph (`via: "tool_call"`). Attribution tier declared `nested`. |
| Client-side terminal and permission duties | Every reverse request is a `toApp` request record (verbatim) and OAR's automatic answer the matching `answered` response; terminals are hosted, permissions follow the fixed allow policy. |

The implementation is divided between the [Grok profile](../../packages/oar/src/runtimes/grok/session.ts),
[ACP opening path](../../packages/oar/src/shared/acp/profile.ts),
[session controller](../../packages/oar/src/shared/acp/session.ts),
[record placement](../../packages/oar/src/shared/acp/records.ts),
[turn machinery](../../packages/oar/src/shared/acp/turns.ts), and
[view projection](../../packages/oar/src/shared/acp/projection.ts).
“Unexposed” below means a native capability has no current OAR operation;
“unverified” means the available evidence does not establish the behavior.

## Capability details

### Starting, authenticating, and creating a session

Native ACP starts with `initialize { protocolVersion, clientCapabilities,
clientInfo, _meta? }`, followed by `authenticate { methodId }` when needed.
`session/new { cwd, mcpServers, _meta? }` returns a new `sessionId`, model
state, and metadata. Credentials must be available in the runtime environment.

OAR launches `grok agent --always-approve --no-leader stdio`, selects the
advertised default auth method or `cached_token`, and sends noninteractive
startup hints. It advertises terminal support, disables client filesystem
methods, and uses 15-second deadlines for opening requests. Its session
request supplies `mcpServers: []` and `_meta: { yoloMode: true }`.
Spawn/auth/creation errors reject `grokRuntime.session(...)`.

### Resuming, loading, and forking

Native `session/resume { sessionId, cwd, mcpServers, _meta? }` returns
configuration/model state and metadata for the existing ID, with **no
transcript replay and no code restoration**. Extra directories and chat-kind
sessions are rejected in this source version. `session/load` accepts the
same identity/workspace fields but delivers history notifications before its
response. Its `_meta.cursor` can restrict replay; configuration or
`_meta['x.ai/restore_code']` can request checking out the persisted HEAD.
See the [attach policy](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L120-L153)
and [resume handler](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L1552-L1575).

With a previously probed available installation, callers use:

```ts
const resumed = await grokRuntime.session(installation, {
  cwd,
  resume: previousSessionId, // Exact earlier Session.id, not a prompt/turn ID.
});
const next = resumed.prompt("Continue");
```

OAR chooses resume when `agentCapabilities.sessionCapabilities.resume` is
`true` or an object; otherwise it selects load when `loadSession === true`,
or rejects. This is capability selection, not a retry after a failed resume.
An optional model is applied afterward with `session/set_model`. Native
persistence errors carry [stable error data](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/session/persistence.rs#L2496-L2516);
OAR propagates opening failures without a separate resume-error result type.

Native resident attachment can report
[`_meta['x.ai/runningPromptId']`](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L1456-L1522).
OAR starts a fresh process, ignores that field, and creates no handle for
previous execution. It retains neither load-time transcript nor replay cursor.
Successful attachment does not establish that an interrupted tool restarted
or an old turn completed. Concurrent same-ID controllers, cross-process live
attachment, and load-fallback code effects remain unverified through OAR.

Native [session fork](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/extensions/session_admin.rs#L994-L1007)
exists as `x.ai/session/fork`; OAR exposes no fork operation. The older 1.0.5
snapshot establishes advertised resume support, not all newer-source details.

### Prompting, steering, queuing, and cancellation

Native `session/prompt { sessionId, prompt: [{ type: "text", text }] }`
streams updates and eventually answers the prompt request. Attachment itself
submits no prompt. Native [prompt identity](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L1074-L1119)
and [queue/send-now dispatch](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L1288-L1343)
are vendor-specific semantics beyond standard ACP.

OAR `prompt()` records a prompt request and answers it `accepted` once the
`session/prompt` RPC is on the wire, or `rejected` (`busy` while a turn is
active; the transport error when the process is gone). The RPC answer is
Grok's own turn end: an event `session/prompt` with `native` = the answer,
a `turn_ended` view (`cancelled` → aborted) and a `usage` view from `_meta`.
An RPC error answer is an event `session/prompt/error` with a failed
`turn_ended`. `steer()` sends another prompt with `_meta.sendNow` inside the
same turn; each answer is its own event, and only the one that leaves no
request pending carries `turn_ended`, with the newest request's outcome.
Acceptance never waits for native acknowledgement. `queue()` is a host-memory
FIFO (`capabilities.queue.durable: false`); a drained input runs as a turn
with an answer but no prompt request of its own.

`abort()` sends `session/cancel` and answers `accepted`; the turn's end is
still the cancelled prompt answer. If none arrives within ten seconds, OAR
kills the process, and the `exited` response is then the turn's end (a
`runtime_exited` failure to `awaitTurnEnd`, not an aborted outcome). The
exact native delivery boundary and effects on background children remain
unverified.

### Events, history, and child sessions

Native child [spawn events](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/subagent/handle_request.rs#L609-L634)
identify parent/child sessions and parent prompt; [completion events](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/subagent/spawn.rs#L318-L368)
report status, usage, and whether the parent will wake. OAR keeps every
`session/update` regardless of session id: a foreign id becomes a
child-session record (envelope `sessionId` = the child's, `agentPath` `[]`,
a node in `Session.graph()`). The profile subscribes to the vendor
notification methods found in the grok 1.0.13 binary's symbol table (all
re-confirmed in grok 1.0.25, `~/.grok/bin/grok`, on 2026-09-11; that build
also carries `_x.ai/session/close`, `_x.ai/relay/init` and
`_x.ai/mcp/servers`, which OAR does not subscribe to) —
`_x.ai/session/update`, `_x.ai/session_notification`,
`_x.ai/sessions/changed`, `_x.ai/task_backgrounded`,
`_x.ai/task_completed`, `_x.ai/session/prompt_complete`,
`_x.ai/session/usage` ([sym] only; **unverified** on a live wire — the
2026-09-11 live check was blocked by missing grok credentials on the probe
machine, and the ACP SDK routes only registered names) — records each verbatim with no
views, and links `parentSessionId` → `sessionId`/`childSessionId` in the
graph when a frame carries that pair. A child whose lineage notification
was not observed stays a node without an edge; OAR never fabricates one.

Views preserve text, reasoning, tool wire IDs, tool boundaries, context
snapshots, and model reports; detail strings truncate at 10,000 characters
but `native` never does. Unknown updates are recorded with no views. A tool
the runtime never ended gets no synthetic end — the turn's `turn_ended`
view is the only closure. The retained stream backs
`subscribe(observer, cursor)` for the life of the process; there is no
native-history enumeration and no rebuild after the process died.

### Model selection and instructions

Native model discovery uses `_x.ai/models/list`; model selection uses
`session/set_model`. [OAR listing](../../packages/oar/src/runtimes/grok/list-models.ts)
handles the extra result envelope and filters hidden/unselectable entries.
Open-time model selection is supported and readback reports the applied
model. Public mid-session model and reasoning-effort setters are absent.

Grok's initialization extensions accept system-instruction configuration.
OAR maps `systemPrompt` to `systemPromptOverride` and `appendSystemPrompt`
to `rules`; these are Grok mappings, not standard ACP fields.

### Context usage and compaction

OAR reads context occupancy from prompt-response `_meta.totalTokens` or
`contextTokens`, not the multi-call `_meta.usage` billing ledger. Window and
percentage may be unknown; per-call and child usage are unexposed.

Native [explicit compaction dispatch](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L2561-L2563)
exists through `x.ai/compact_conversation`; automatic compaction remains
native harness behavior. OAR has no typed compaction operation.

### Tools, MCP, and permissions

Native ACP supports terminal and permission reverse requests; vendor tools
and configured MCP integrations execute within the harness. OAR's
[client implementation](../../packages/oar/src/shared/acp/terminal.ts) hosts
terminals, including Grok's full shell-line `command` compatibility. It
selects `allow_always`, then `allow_once`, otherwise cancellation for reverse
permission requests, alongside the launch/session yolo settings. Each reverse
request (`session/request_permission`, `terminal/*`) is recorded as a `toApp`
request under the runtime's JSON-RPC id, and OAR's reply as the `answered`
response — including terminal output payloads, verbatim.

There is no application approval callback, generic client-tool callback, or
per-session MCP configuration. Passing no MCP servers and disabling client
filesystem methods does not disable every vendor-configured tool.

### Release and account usage

Native ACP advertises session close. OAR disposal cancels active work,
attempts `session/close` when supported, kills its process, and disposes hosted
terminals. Disposal does not delete the persistent native session.

[Account usage](../../packages/oar/src/runtimes/grok/account-usage.ts) separately
queries Grok billing/auth extensions. Account quota, prompt billing, and
context occupancy are distinct APIs and measurements.

## Tests and remaining evidence

[ACP session tests](../../tests/acp/acp-session.test.ts) and
[model/usage tests](../../tests/acp/acp-session-model-usage.test.ts) use a fake
agent for the record skeleton of a tool turn, busy/queue behavior, send-now
steer folding, toApp permission records, prompt-error versus process-exit
ends, resume identity, child-session records, extension-notification graph
edges, and model readback. [Terminal tests](../../tests/acp/acp-terminal.test.ts) cover
shell compatibility, truncation, and cleanup. Snapshot tests check recorded
schema assumptions, not execution of the current harness.

The [CI behavior matrix](../../.github/workflows/ci.yml) runs real Claude,
Codex, and Pi backends, not Grok. Priority Grok probes are concurrent children,
observable steer acceptance, resume continuity, cancellation with background
children, and usage across compaction. Design should distinguish restoring
context, replaying observations, and adopting live execution; current OAR's
returned Session does not imply all three.
