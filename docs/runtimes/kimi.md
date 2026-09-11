# Kimi

Evidence baseline: native source
[`kimi-code` `f9ca33376`](https://github.com/MoonshotAI/kimi-code/tree/f9ca33376)
(0.41.0, reviewed 2026-09-08). The checked-in
[wire snapshot](../../tests/replay/fixtures/kimi-acp-v1.vendor.json) is
**0.38.0** (2026-08-26; `acp-runtime.ts kimi` records 2026-08-27 on the same
version). Live observations below come from **kimi 0.42.0** (`agentInfo.name`
"Kimi Code CLI", darwin arm64, default model `kimi-code/k3`, no `--model`) on
2026-09-11 through [`experiments/live-contract.ts kimi`](../../experiments/live-contract.ts)
(scenario names in parentheses below) and the kimi probes listed in the
[experiments index](../../experiments/README.md): `kimi-wire-tap.ts`,
`kimi-usage-update-order.ts live`, `kimi-steer-or-queue.ts`. Versions are
evidence baselines, not a support range. The [spec](../spec/README.md) is the
contract the adapter implements, not evidence of this adapter's behavior; see
the [runtime index](README.md) for status conventions.

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
expose every agent in the native session. OAR uses `kimi acp`.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as an event's `native`; the cross-runtime `views` are what
OAR read out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `kimi-code` executable | One `kimi acp` subprocess per OAR Session, spawned in the session `cwd` with the env overlay; its exit is an `exited` response record (answering `dispose` when OAR caused it, `requestId ""` when the process died on its own). |
| Persistent native session | `Session.id` is the native `sessionId`; `SessionOptions.resume` attaches through ACP `session/resume` with a fresh stream (seq 0; no history rebuild). |
| Handshake answers and opening pushes | `initialize`, `authenticate`, `session/new`/`resume`/`load`, `session/set_model` answers are event records with a `model` view where they report one; pushes arriving while opening (`available_commands_update`, `current_mode_update`, `config_option_update`) are recorded in arrival order, so `Session.model()` is a fold over the stream. |
| Native agent and turn | Only ACP's `main` agent reaches this transport; every `session/update` is one event with `native` verbatim. No `spanId` (ACP updates carry no turn id). Attribution tier declared `opaque`. |
| Prompt, steer, queue, and cancel | `prompt()` is a `toRuntime` request answered `accepted`/`busy`; the `session/prompt` answer is an event with the `turn_ended` view. Steer is always `rejected not_steerable` (no ACP method); `queue()` is a host-memory FIFO, `durable: false`; `abort()` is `session/cancel` with a kill fallback. |
| Typed events, history, and child graph | Views for message/thought/tool/usage/model updates; unknown kinds recorded with no views. No child session ever arrives on this transport, so the graph holds the root only. |
| Client execution and interaction duties | Every reverse request (`session/request_permission`, `terminal/*`) is a `toApp` request record and OAR's fixed-policy answer the `answered` response. |

See the [Kimi profile](../../packages/oar/src/runtimes/kimi/session.ts),
[ACP opening path](../../packages/oar/src/shared/acp/profile.ts),
[session controller](../../packages/oar/src/shared/acp/session.ts),
[record placement](../../packages/oar/src/shared/acp/records.ts),
[turn machinery](../../packages/oar/src/shared/acp/turns.ts),
[view projection](../../packages/oar/src/shared/acp/projection.ts), and
[client app](../../packages/oar/src/shared/acp/client-app.ts), alongside
the [native ACP reference](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/docs/en/reference/kimi-acp.md).
"Unexposed" means OAR has no mapping; "transport-limited" means the selected
native boundary already loses the capability; "unverified" means evidence
is missing.

## Capability details

### Session creation and resume

Native ACP requires `initialize` with the protocol version and client
capabilities. `authenticate { methodId: "login" }` validates readiness rather
than starting login: the
[auth gate](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/server.ts#L626-L645)
accepts engine-ready credentials, with an OAuth-summary fallback.
`session/new { cwd, mcpServers, additionalDirectories? }` returns an
engine-generated `sessionId`, `configOptions`, and `modes`.

**What the runtime advertises (0.42.0):** `initialize` answers `loadSession:
true`, `sessionCapabilities` `list`/`resume`/`close`/`delete`/`fork`/
`additionalDirectories`, `promptCapabilities` image + embeddedContext (no
audio), `mcpCapabilities` http + sse, and one auth method `login`
(`type: "terminal"`, a device-code flow OAR never starts). `session/new`
answers `sessionId`, `configOptions` (`model`, `thinking` with
`low`/`high`/`max`, `mode` with `default`/`plan`/`auto`/`yolo`) and `modes`
(the same four); the model catalog is listed under
[Models](#models-instructions-and-context).

**Mapped:** OAR launches `kimi acp` (initialize declares `fs` read/write
`false`, `terminal: true`, `clientInfo` `oar`), selects the advertised `login`
method, passes `mcpServers: []`, applies a requested model through
`session/set_model`, then selects yolo through `session/set_mode` when the
answer advertises it (in `modes` or the `mode` config option). Every opening
request has a 30-second deadline; spawn, auth, and creation failures reject
session construction with the process killed. The opening stream is six
events: `initialize`, `authenticate` (`{}`), `session/new` (model view), then
three pushes: `available_commands_update` (the slash commands, `compact`
first) right after the `session/new` answer, and `current_mode_update`
(`yolo`) plus `config_option_update` (model view again) between the
`session/set_mode` request and its `{}` answer. Opening takes about 1.9 s
(`basic`). Credentials and persisted sessions must be accessible in the
subprocess's configured data root.

**Resume (mapped):** native `session/resume { sessionId, cwd, mcpServers,
additionalDirectories? }` restores the existing session and returns
`configOptions` and `modes` **without history replay**; `session/load` has the
same request shape but awaits ordered history `session/update` notifications
before responding (history is not a response messages array). The
[handlers](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/server.ts#L296-L322)
ignore `cwd`, warn and ignore `additionalDirectories`, and pass MCP settings
to restore; [cold restore](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/server.ts#L533-L570)
can apply those ephemeral servers, already-live sessions pass through.
Unknown IDs return `invalid_params` (`-32602`); missing authentication returns
`auth_required` (`-32000`). Neither creates a substitute session.

```ts
const resumed = await kimiRuntime.session(installation, {
  cwd,
  resume: previousSessionId, // Exact earlier Session.id, not an agent/turn ID.
});
const next = resumed.prompt("Continue");
```

OAR selects `session/resume` when `sessionCapabilities.resume` is `true` or
an object, otherwise `session/load` when `loadSession === true`, otherwise
rejects; it does not retry a failed resume as load. The resume answer carries
`configOptions` + `modes` only (no `sessionId`, nothing replayed on the wire);
the resumed stream restarts at seq 0 with the same six-event opening,
`session/resume` in place of `session/new`, and `Session.id` is the earlier
id. The next prompt recalls what was taught before disposal (`resume`
scenario: a codeword). Success returns a Session with the supplied native ID
and no restored Turn handle or transcript; history pushed during a
`session/load` opening is not retained. Concurrent same-ID controllers and
continuing in-flight work across OAR subprocesses are **unverified**.

The Node SDK separately offers
[`harness.resumeSession({ id, includeSubagents?, replayTurnLimit?, ... })`](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/node-sdk/src/types.ts#L222-L237),
which returns a native Session and [reuses/coalesces facades](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/node-sdk/src/kimi-harness.ts#L166-L225)
for active or identical concurrent resumes inside that harness; ACP uses
`klient.session(id).restore()` and rebuilds its main-agent wrapper. OAR
neither exposes the SDK replay options nor inherits its coalescing guarantee
(source facts, not observed on the 0.38.0 snapshot). Native ACP also
implements session list, delete, and fork; OAR exposes **none** of those:
resume is neither a session browser nor a fork API.

### Prompt, steering, queueing, and abort

Native `session/prompt { sessionId, prompt: [{ type: "text", text }] }`
streams updates and returns a `stopReason`. Attachment submits no prompt.
The native ACP driver buffers events arriving before the launch returns a
turn ID and can bind a `session/cancel` request to that eventual ID. Native
ACP accepts image and resource blocks; OAR sends only one text block. Audio
is explicitly unsupported in the capability declaration.

**Prompt (mapped):** `prompt(string)` records a prompt request answered
`accepted` once the RPC is on the wire, or `rejected` (`busy` during a turn,
the transport error when the process is gone). The RPC answer is recorded as
event `session/prompt` with the `turn_ended` view; an RPC error answer as
`session/prompt/error` with a failed end
([test](../../tests/acp/acp-session.test.ts)); a second `prompt()` during a
turn is `rejected busy` (`busy-and-late-control`).

**Steer (not available on this transport):** the native SDK and agent
services support steering, but the ACP method set has no steer operation, so
`steer()` is always `rejected not_steerable` and `capabilities.steer` is
false, after a turn as well as during one. `steerOrQueue()` therefore lands
`queued`: the steer request is rejected, the queue request accepted, and the
input runs after the current turn (`kimi-steer-or-queue.ts`).

**Queue (mapped):** `queue()` is a host-memory FIFO
(`capabilities.queue.durable: false`, no claim about native queue
durability), drained one input per turn end; the drained input runs as a
spontaneous turn with its own `session/prompt` answer and no prompt request
of its own (`queue`). Held input is dropped once the runtime is unreachable.

**Abort (mapped):** `abort()` sends `session/cancel` (a notification, so
the `accepted` answer carries no `native`) and is `rejected no active
turn` after the turn. Kimi then asks the client to `terminal/kill` the running
command, `wait_for_exit` answers `SIGTERM`, the tool ends `status: "failed"`,
and the prompt answers `stopReason: "cancelled"` about one second later,
recorded as `turn_ended: aborted` (`abort`). If the cancelled prompt is not
answered within ten seconds OAR kills the process and the `exited` response
is the turn's end; the fallback has not been needed live. Kimi still pushes
the turn's `usage_update` after a cancelled answer (about 1 ms later); the
usage gate does not wait while aborting, so on an aborted turn that record
lands after the turn end. Effects on background children are **unverified**.

**Outcomes:** native ACP [maps most non-auth failures to `end_turn`](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/events-map.ts#L59-L74);
blocked/filtered cases become `refusal`, while auth failures use the RPC
error channel. OAR's `turn_ended` view maps `cancelled` to aborted and every
other stop reason to completed; the answer itself is in the event's `native`,
so a consumer can still read `refusal` or any other stop reason the runtime
gave. This separates loss before OAR receives a response (native) from OAR's
reading (the view). Opening with an unknown model makes `session/set_model`
answer a JSON-RPC error `-32603 "Internal error"` with `data.details`
`Model "<id>" is not configured in config.toml.`; session construction
rejects with the SDK's `RequestError` (message `Internal error`, the details
on its `data`) and no OAR session or log exists (`bad-model`).

**Unreachable runtime:** `dispose()` mid-turn runs the cancel path, then
`session/close` (advertised; answered `{}`), then the kill; the dispose
request is answered by the `exited` response (`dispose-mid-turn`). The exit
code is `null` (signal), except when the process exits `0` on `session/close`
before the kill (seen once, `subagent`). When `kimi acp` dies on its own
(SIGKILL mid-turn), the stream gets an `exited` response with `requestId ""`
and `code: null`, which is the turn's end (read as failed /
`runtime_exited`); a later `prompt()` is rejected and a later `dispose()` is a
request answered `accepted` (`kill-runtime`;
[test](../../tests/acp/acp-kimi-wire-shapes.test.ts)).

### Observation, children, and history

**Mapped:** every update is an event with `native` verbatim; views carry
text (`agent_message_chunk` → `text_delta`), reasoning, tool boundaries,
context snapshots, and model reports. Reasoning arrives as
`agent_thought_chunk` text deltas ending with an empty chunk (`reasoning:
empty`); `session_info_update` (the session title) is recorded viewless after
each first prompt. Native `${turnId}:${toolCallId}` wire IDs survive as call
IDs. Detail strings truncate at 10,000 characters (`native` does not); tool
progress/status distinctions are in `native` only; a tool the runtime never
ended gets no synthetic end. `Session.usage()` totals stay zero: no frame
carries token totals, only `usage_update` context.

**Tool frames:** the opening `tool_call` carries `title`, `kind`
(`execute` for `Bash`, `other` for `Agent`), `status: "pending"`, an empty
`content` text block, and no `rawInput`, so `tool_call_started` has no
`input`. The arguments then stream as partial-JSON `content` text over a
dozen `tool_call_update` frames (viewless), and one more update carries the
full `rawInput` (`{"command": …}`) with `title` "Running: …". The command runs
through `terminal/create` (`/bin/bash -c "cd '<cwd>' && …"`, env `NO_COLOR`,
`TERM=dumb`, …), `wait_for_exit`, `output`, `release`, each a `toApp` request
with OAR's answer: the captured output is in the `terminal/output` answer.
The completed frame's `content` is a terminal reference
(`{type: "terminal", terminalId}`) with no `rawOutput`, so
`tool_call_ended.output` is that reference as JSON, not the command's text
(`tool-detail`). The `tool` label is the opening `tool_call` frame's `title`
rather than the ACP `kind` category; for the two tools observed live (`Bash`,
`Agent`) that title is the tool's name, whether every kimi tool opens with its
name as `title` is **unverified**. A call first seen on a `tool_call_update`
(whose `title` is progress text) is labelled by `kind`; an explicit
`name`/`toolName` always wins
([test](../../tests/acp/acp-kimi-wire-shapes.test.ts)).

**Children (transport-limited, `opaque`):** the
[native child schema](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/protocol/src/events.ts#L878-L927)
contains `subagentId`, `parentToolCallId`, optional `parentAgentId`, and
`runInBackground`; completion can carry usage and context tokens. ACP
subscribes to `main`, so children never reach OAR and the adapter fabricates
nothing. Asked to delegate one shell command, the root runs an `Agent` tool
call whose arguments stream as `content` text (`prompt`, `description`,
`subagent_type: "coder"`); the child's own Bash call surfaces ONLY as the
root session's `terminal/create` → `wait_for_exit` → `output` → `release`
reverse requests, under the root `sessionId`: no `session/update` for the
child, no `tool_call` frame for its Bash. The Agent call's completed frame
carries the child's report as `rawOutput` (`agent_id: agent-0`,
`actual_subagent_type: coder`, `status: completed`, a `resume_hint` naming
`Agent(resume="agent-0")`). Every record carries the root `sessionId`,
`agentPath` is `[]` throughout, and the graph has one node (`subagent`). A
root `Agent` tool card is not a child trajectory. OAR does not filter by
session id: should a future `kimi acp` emit updates for other session ids,
they would be recorded as child-session records. (The `isFromMainAgent`
guard lives in the older `acp-adapter` package; this baseline uses
`acp-server` with scoped subscriptions, see runtime-matrix.md.)

**History:** the retained stream backs `subscribe(observer, cursor)` for the
life of the process (`cursor`); there is no native-history enumeration and
no rebuild after the process died.

### Models, instructions, and context

Native ACP config options cover model, thinking, and mode, with
`session/set_model` retained as an extension. Every switch pushes
`config_option_update` before the switch request is answered, and the
`set_model` answer is `{}`.

**Mapped:** open-time model selection (`SessionOptions.model` →
`session/set_model`) and early config-update readback: `Session.model()` is
the latest `model` view, read from `configOptions` id `model` on the open
answer and from every `config_option_update`, never from the request
parameter. Public mid-session setters are absent. The
[model lister](../../packages/oar/src/runtimes/kimi/list-models.ts) creates a
temporary authenticated session (`terminal: false`), reads the `model`
config option, closes and kills it; a `thinking` option is emitted only for
the current model, so effort levels attach to that entry only (`off` is a
toggle and dropped). `-32601` reads as unsupported, `-32000` or an auth
message as unauthenticated. On this account the 0.42.0 catalog is
`kimi-k2.5`, `kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed`,
`kimi-code/k3` (current, thinking `high`), `kimi-code/k3-256k`.

The OAR profile rejects `systemPrompt` and `appendSystemPrompt` because its
selected ACP integration exposes no override. This is not a claim that the
native harness cannot configure instructions.

**Context (partial):** native ACP
[emits context usage after the prompt response](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/session.ts#L907-L947)
from an un-awaited task and may omit it when the catalog has no size for the
model. OAR holds the `session/prompt` answer event at most 500 ms for that
push (`usageUpdateAfterPrompt`), then records the answer as-is; this keeps
the usage record before the turn end but is not a freshness guarantee. Live
the push follows the answer by about 8 ms, so `contextUsage()` at
`turn_ended` reads the turn's own value: growing across turns, e.g.
`[20611, 20657]` (`kimi-usage-update-order.ts live`). `size` is `1048576` for
`kimi-code/k3`; a one-word turn already occupies about 20.6k tokens (the
system prompt). Per-agent usage remains unexposed.

Native agent compaction exists; ACP
[`/compact` dispatches a background task](https://github.com/MoonshotAI/kimi-code/blob/f9ca33376/packages/acp-server/src/builtin-commands.ts#L100-L110).
OAR has no typed compact operation. Prompt text can reach that slash route,
but completion text emitted after the OAR Turn ends is dropped; prompt
completion does not establish compaction completion.

### Tools, permissions, and extensions

Native ACP accepts MCP configuration and supports filesystem, terminal, and
interaction reverse calls; its permission channel handles tool approvals and
question fallback. OAR's [client](../../packages/oar/src/shared/acp/terminal.ts)
hosts terminals (`create`, `output`, `wait_for_exit`, `kill`, `release`, run
in the session `cwd` with the env overlay, output capped at 4 MiB by
default), disables client filesystem methods, and passes no MCP servers.
Vendor-configured tools can still run, but OAR has no per-session MCP
configuration or generic client-tool callback.

OAR uses yolo when available and answers `session/request_permission` with
`allow_always`, then `allow_once`, otherwise `cancelled`. With yolo selected
no `request_permission` arrives; the only reverse requests are `terminal/*`,
and while a command runs kimi polls `terminal/output` every ~250 ms, each poll
a `toApp` request/answer pair (`busy-and-late-control`, `kimi-wire-tap.ts`).
Each reverse request is recorded as a `toApp` request under the runtime's
JSON-RPC id and OAR's reply as the `answered` response, verbatim (terminal
output included). No caller decision channel exists, so approval and question
semantics cannot be represented as application interactions. The stream
shows what was asked and what OAR answered.

### Process ownership, installation, and account usage

**Mapped:** OAR owns the spawned process. Native ACP close tears down a live
session; delete is a separate operation. Disposal cancels active work,
attempts the advertised `session/close`, kills the process, and disposes
hosted terminals; a dispose after an observed exit is answered `accepted`
without further work. It does not delete persisted native sessions.

[Installation detection](../../packages/oar/src/runtimes/kimi/installation.ts)
checks `OAR_KIMI_BIN`, PATH `kimi`, `$KIMI_INSTALL_DIR/bin/kimi`,
`~/.kimi-code/bin/kimi`, and the legacy `kimi-code` name, probing
`kimi acp --help` with 30-second timeouts; it does not prove compatibility
with Python kimi-cli.

[Account usage](../../packages/oar/src/runtimes/kimi/account-usage.ts)
resolves the managed `kimi-code` provider through `kimi provider list --json`
(honouring `KIMI_CODE_BASE_URL`, `KIMI_CODE_OAUTH_HOST`, `KIMI_CODE_HOME`),
reads the stored OAuth token as-is (never refreshed), and calls the `/usages`
and `/me` endpoints; 401/403 or a missing token read `reauth_required`, 404
`unsupported`. Account quota and session context occupancy are distinct
APIs; neither supplies the missing child-agent usage stream.

## Verification and open gaps

[`experiments/live-contract.ts kimi`](../../experiments/live-contract.ts)
covers the promises above on the real login: `basic`, `multi-turn`,
`tool-detail`, `busy-and-late-control`, `steer`, `queue`, `abort`,
`dispose-mid-turn`, `cursor`, `resume`, `subagent`, `kill-runtime`,
`bad-model`. [`kimi-wire-tap.ts`](../../experiments/kimi-wire-tap.ts) checks
the raw JSON-RPC below the SDK against the record stream: one shell-tool turn
is outbound `initialize`, `authenticate`, `session/new`, `session/set_mode`,
`session/prompt`, `session/close`, all answered; inbound 49 `session/update`
notifications (`available_commands_update` 1, `current_mode_update` 1,
`config_option_update` 1, `session_info_update` 1, `agent_thought_chunk` 22,
`tool_call` 1, `tool_call_update` 14, `agent_message_chunk` 7, `usage_update`
1) and four `terminal/*` requests (no vendor extension notification, no
unknown method) and every one reaches the stream with the same count
(`missingFromStream: []`).
[`kimi-usage-update-order.ts`](../../experiments/kimi-usage-update-order.ts)
separates fixture and live modes;
[`kimi-steer-or-queue.ts`](../../experiments/kimi-steer-or-queue.ts) covers
`steerOrQueue()`.

[ACP tests](../../tests/acp/acp-session.test.ts) and
[model/usage tests](../../tests/acp/acp-session-model-usage.test.ts) use a fake
executable for the record skeleton, control accept/reject, early model
updates, and late/missing usage updates (the usage record is deliberately
held before the turn end).
[Wire-shape tests](../../tests/acp/acp-kimi-wire-shapes.test.ts) pin the
0.42.0 tool frames (title-only opening, late `rawInput`, terminal-reference
completion, the Agent report) and the dispose-after-death answer.
[Snapshot tests](../../tests/acp/acp-vendor-snapshot.test.ts) bind login and
yolo selection to the recorded 0.38.0 schema. The
[real-runtime CI matrix](../../.github/workflows/ci.yml) excludes Kimi.

Open gaps: questions and approvals (no `request_permission` arrives under
yolo), post-turn compaction, whether every kimi tool opens with its name as
`title`, abort effects on background children, concurrent same-ID
controllers and in-flight work across OAR subprocesses, and any child usage
(the transport carries none). Keep native API capabilities, transport
limitations, OAR omissions, and unexecuted checks separate when designing or
claiming support.
