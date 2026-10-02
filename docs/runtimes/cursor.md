# Cursor

Independent inventories: not implemented for Cursor yet.
See the [query contract](../spec/inventory.md) and [native probe evidence](inventory.md).

Evidence baseline: **cursor-agent 2026.09.28-64d2043** (the Cursor CLI from
the official installer, linux x64, model `gpt-5.4-nano`) on 2026-09-29
through [`experiments/live-contract.ts cursor`](../../experiments/live-contract.ts):
13/13, with the `subagent` scenario run under the subagent opt-in (nested, one
edge); scenario names appear in parentheses below. On **2026.10.01-e373342**
(2026-10-02) `basic` and `tool-detail` passed; the other scenarios were not
rerun ([version check](../../experiments/runtime-version-checks/2026-10-02.md)).
The CLI ships as a bundled JavaScript application with no public source, so
statements about native behavior beyond the wire come from its installed
bundle and are marked as such. Versions are evidence baselines, not a support
range; see the [runtime index](README.md) for status conventions.

## Native concepts and calling interfaces

A native session is a persistent chat with an id, a working directory, a
mode (`agent`, `plan`, `ask`), and a model with per-model parameters. Chats
are stored under `~/.cursor/` (`chats/`, `acp-sessions/`); a child agent
started through the Task tool is its own native session with its own id.

The CLI (`cursor-agent`, also linked as `agent`) offers the terminal
application, a print mode (`-p` with `--output-format stream-json`), and a
hidden `acp` subcommand that speaks ACP JSON-RPC over stdio. Print mode is a
one-shot stream with no control channel while a turn runs; ACP is the only
surface with prompt, cancel, load and reverse requests on one connection.
OAR uses `cursor-agent --force acp`.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as a frame's `native`; the cross-runtime `events` are what
OAR reads out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `cursor-agent` executable | One `cursor-agent --force acp` subprocess per OAR Session, spawned in the session `cwd` with the env overlay; its exit is an `exited` response record. |
| Persistent native session | `Session.id` is the native `sessionId`; `SessionOptions.resume` attaches through `session/load`, which replays history onto the new stream. |
| Handshake answers and opening pushes | Answers are Frame records with `model` and `effort` events where they report one; pushes are recorded in arrival order. `Session.model()` and `effort()` are folds over the stream. |
| Native agent and turn | Every `session/update` is one frame with `native` verbatim. No `spanId` (ACP updates carry no turn id). Attribution tier `nested`: with the subagent opt-in each child speaks under its own session id and is linked to the parent. |
| Prompt, steer, queue and cancel | A turn is one `session/prompt` RPC, its answer carrying `turn_ended`. No steer; `queue()` is a host-memory FIFO; `abort()` is `session/cancel` with a kill fallback. |
| Typed events, history and child graph | Events for message, thought, tool and model updates; unknown kinds are recorded with no events. No usage, compaction or retry frame arrives. Two vendor subagent updates are carried past the SDK and add the graph edge. |
| Client execution and interaction duties | Cursor runs its own tools; its five vendor requests are recorded and refused with `-32601`. |

Sources: [Cursor profile](../../packages/oar/src/runtimes/cursor/session.ts),
[vendor update carrier](../../packages/oar/src/shared/acp/vendor-updates.ts),
[ACP opening path](../../packages/oar/src/shared/acp/profile.ts),
[session controller](../../packages/oar/src/shared/acp/session.ts),
[record placement](../../packages/oar/src/shared/acp/records.ts),
[turn machinery](../../packages/oar/src/shared/acp/turns.ts),
[event projection](../../packages/oar/src/shared/acp/projection.ts),
[client app](../../packages/oar/src/shared/acp/client-app.ts).

## Capability details

### Session creation and resume

**What the runtime advertises (2026.09.28):** `initialize` answers
`loadSession: true`, `sessionCapabilities` with `list` only (no `resume`, no
`close`), `promptCapabilities` image (no audio, no embeddedContext),
`mcpCapabilities` http + sse, and one auth method `cursor_login` ("Cursor
Login": reuse existing credentials, run `agent login` first). `session/new`
answers `sessionId`, `modes` (`agent`, `plan`, `ask`; current `agent`),
`models`, and `configOptions`: `mode`, `model`, and the current model's
parameters, each its own select option (`model_config` for context size and
fast, `thought_level` for the reasoning one, whose id is `effort`,
`reasoning`, `reasoning_effort` or `thinking` depending on the model).

**Mapped:** OAR launches `cursor-agent --force acp`. `--force` (alias
`--yolo`) is a root option, so it precedes the hidden subcommand; it runs
commands without asking, so there is no yolo mode to select. Initialize
declares `fs` read/write `false`, `terminal: true`, `clientInfo` `oar`, and
`_meta` `{parameterizedModelPicker: true, subagents: true}`. Without the
picker flag cursor answers in its "variants" picker mode, where every model
and effort pair is one flat `model` value and no `thought_level` option
exists; without `subagents` a child is visible only as the parent's `task`
tool call. OAR selects `cursor_login`, passes `mcpServers: []`, and applies a
requested model through `session/set_config_option {configId: "model"}`: the
`session/set_model` answer is `{}` and cursor never pushes
`config_option_update`, so only the config option answer reports the switch.
Every opening request has a 30 second deadline; spawn, auth and creation
failures reject session construction with the process killed. The opening
stream is five records: `initialize`, `authenticate` (`{}`), `session/new`
(model event), `available_commands_update` (the slash commands), and the
`session/set_config_option` answer (`model` and `effort` events, e.g.
`gpt-5.4-nano` at `medium`). Opening takes about 4.5 s (`basic`). Credentials
and persisted sessions must be accessible under the subprocess's `HOME`.

**Resume (mapped):** OAR resumes through
`session/load { sessionId, cwd, mcpServers }`. Cursor replays the chat as
standard updates around the answer: live, the earlier prompt arrived as a
`user_message_chunk` before the `session/load` answer and the earlier reply as
an `agent_message_chunk` after it, both under the same session id. OAR records
the replay in arrival order, so a resumed stream (seq 0) opens with the
history before `available_commands_update` and the model switch; the replayed
`agent_message_chunk` carries a `text_delta` event outside any turn.
`Session.id` is the earlier id, and the next prompt recalls what was taught
before disposal (`resume` scenario: a codeword).

```ts
const resumed = await cursorRuntime.session(installation, {
  cwd,
  resume: previousSessionId, // Exact earlier Session.id.
});
const next = resumed.prompt("Continue");
```

Unknown ids, concurrent same-id controllers, and continuing in-flight work
across OAR subprocesses are **unverified**. Native `session/list` is
advertised; OAR does not expose it.

### Prompt, steering, queueing, and abort

**Prompt (mapped):** `prompt(string)` records a prompt request answered
`accepted` once the RPC is on the wire, or `rejected` (`busy` during a turn,
`busy-and-late-control`; `runtime_exited` once the process is gone). The RPC
answer is recorded as frame `session/prompt` with the `turn_ended` event.
Cursor pushes a `session_info_update` (the chat title) shortly after the first
prompt of a session. `InputOptions.images` go as ACP `image` blocks before the
text, since `initialize` advertises `promptCapabilities.image`; delivery to
cursor's model was probed live (cursor-agent 2026.05.09-0afadcc, 2026-09-29):
asked for the color of a plain green PNG named `probe.png`, it answered
`green`.

**Steer (not available on this transport):** ACP has no steer method, so
`steer()` is always `rejected` (`unsupported`, reason `not_steerable: runtime
cannot inject into an active turn`) and `capabilities.steer` is false
(`steer`). `steerOrQueue()` therefore lands `queued`.

**Queue (mapped):** `queue()` is a host-memory FIFO
(`capabilities.queue.durable: false`), drained one input per turn end; the
drained input runs as a spontaneous turn with its own `session/prompt` answer
and no prompt request of its own (`queue`). Held input is dropped once the
runtime is unreachable.

**Abort (mapped):** `abort()` sends `session/cancel` (a notification, so the
`accepted` answer carries no `native`) and is `rejected no active turn` after
the turn. With a shell command running, cursor answers the prompt
`stopReason: "cancelled"` about 10 ms after the cancel, recorded as
`turn_ended: aborted` (`abort`); no `tool_call_update` ends the running call.
If the cancelled prompt is not answered within ten seconds OAR kills the
process; that fallback has not been needed live.

**Outcomes:** `turn_ended` maps `cancelled` to aborted and every other stop
reason to completed; the answer itself is the event's `native`. Opening with
an unknown model makes `session/set_config_option` answer `-32602 "Invalid
params"` with `data.message` `Invalid model value: <id>`; session construction
rejects with that error and no OAR session exists (`bad-model`).

**Unreachable runtime:** `close` is not advertised, so `dispose()` mid-turn
runs the cancel path, then the kill; cursor exits `143` on SIGTERM and the
dispose request is answered by that `exited` response, which also ends the
open turn as failed (`runtime_exited`, `dispose-mid-turn`). When the process
dies on its own (SIGKILL mid-turn), the stream gets an `exited` response with
`requestId ""` and `code: null`, which is the turn's end; a later `prompt()`
is rejected and a later `dispose()` is answered `accepted` (`kill-runtime`).

### Observation, children, and history

**Mapped:** every update is a frame with `native` verbatim; events carry text
(`agent_message_chunk` → `text_delta`), reasoning (`agent_thought_chunk`,
present in some turns only: none in `tool-detail`, dozens in `abort` and
`queue` with the same model), tool boundaries and model reports. Detail
strings truncate at 10,000 characters (`native` does not). `Session.usage()`
totals and `contextUsage()` stay empty: cursor sends no `usage_update` and no
token totals on any answer.

**Tool frames:** Cursor executes tools itself. A shell call opens with a
`tool_call` whose `title` is the command in backticks, `kind: "execute"`,
`status: "pending"` and `rawInput {command}`, so `tool_call_started` carries
the command as `input`. An `in_progress` update follows, then a `completed`
update with `rawOutput {exitCode, stdout, stderr}`, which becomes
`tool_call_ended.output` with `result: "ok"` and `exitCode` (`tool-detail`).
OAR maps the explicit ACP `ToolCallStatus` values `completed` / `failed` to
`result: "ok"` / `"failed"`; a non-terminal or missing status leaves `result`
absent. The `toolCallId` is two lines (`call_…\nfc_…`) and survives verbatim
as the call id.

**Children (mapped, `nested`):** with the `subagents` opt-in, cursor announces
a Task-tool child on the parent's `session/update` as `subagent_spawned
{subagentSessionId, name, task, capabilities, _meta.cursor.{toolCallId,
agentId}}` and later `subagent_state_update` (completed, failed, cancelled or
disconnected); the child's own standard updates arrive under its session id.
The ACP SDK (1.4.0) parses every `session/update` against the closed set of
standard kinds and silently drops the rest, so the
[carrier](../../packages/oar/src/shared/acp/vendor-updates.ts) rewrites those
two kinds into `session_info_update` frames holding the original under
`_meta["oar/vendorSessionUpdate"]` before the SDK sees them, and the recorder
restores the original as `native`. They stay in wire order with the child's
updates. `subagent_spawned` adds the graph edge (`via: "tool_call"`). Live
(`subagent`): two graph nodes, one edge; the root has `subagent_spawned` and
`subagent_state_update` once each, the child session 22 message chunks and its
own shell call. The parent still sends `cursor/task` (tool call id,
description, prompt, model, agent id, duration) as a `toApp` request after
the child finishes; it is refused like the other vendor requests. Child usage
is not reported.

**History:** the retained stream backs `rawEvents(observer, cursor)` for the
life of the process (`cursor`); OAR enumerates no native history, and the only
replay is the one `session/load` produces.

### Models, instructions, and context

**Mapped:** open-time model selection (`SessionOptions.model` →
`session/set_config_option {configId: "model"}`), read back from the answer's
`configOptions`, never from the request parameter. The
[model lister](../../packages/oar/src/runtimes/cursor/list-models.ts) starts a
temporary ACP process (`terminal: false`, the same `_meta`), authenticates,
and calls the vendor method `cursor/list_available_models`, which answers
`{models: [{value, name, configOptions}]}` for every model at once, each with
its parameters at their defaults. Effort levels come from each model's
`thought_level` option. `-32601` reads as unsupported, `-32000` or an auth
message as unauthenticated; the default deadline is 15 s. On this account the
catalog has about 45 models with `default` (Auto) first; for example
`gpt-5.4-nano` offers `none`/`low`/`medium`/`high`/`xhigh` (default `medium`)
and `claude-opus-5-5` offers `low` through `max`.

**Effort (mapped):** `SessionOptions.effort` is `session/set_config_option` on
the model's `thought_level` option, sent after the model switch so it lands on
the switched model's menu. A Claude model with both a `thinking` switch and an
`effort` menu gets the menu. The answer carries every option's current value
and so the `effort` event.

**Global persistence (caveat):** cursor writes every model and parameter
change to the account-wide `~/.cursor/cli-config.json` (`model`,
`modelParameters`, `selectedModel`), the same file that holds the approval
allowlist. A session opened with a model therefore changes the default for
later sessions and for the terminal application under the same `HOME`. Run
OAR sessions under a dedicated `HOME` when that matters.

The OAR profile rejects `systemPrompt` and `appendSystemPrompt` because
Cursor's ACP exposes no override.

**Context (unexposed by the runtime):** no frame carries context occupancy, so
`contextUsage()` stays empty. Cursor advertises no compaction through ACP.

### Tools, permissions, and extensions

Cursor runs shell, file and search tools itself: no `terminal/*` or `fs/*`
request arrived in any scenario, so OAR's terminal host is never called. OAR passes no MCP servers; vendor-configured tools can still
run.

`--force` runs commands without asking, and no `session/request_permission`
arrived in any scenario. The installed bundle shows a team whose admin
controls auto run can switch `--force` off; the agent then asks through
`session/request_permission`, which OAR answers with `allow_always`, then
`allow_once`, otherwise `cancelled`. That path is **unverified** live.

Cursor sends five vendor requests to its client: `cursor/ask_question`,
`cursor/create_plan`, `cursor/update_todos`, `cursor/task` and
`cursor/generate_image`. OAR implements none: each is recorded as a `toApp`
request and refused with `-32601`, as the SDK refuses any unregistered
method; `events()` reads each pair as `app_request` (method as `type`) and
`app_answered`. From the installed bundle: on that refusal
`cursor/ask_question` falls back to one `session/request_permission` per
single-select question (OAR picks its first option), `cursor/create_plan`
writes the plan to a local file, and the other three are notices the agent
does not wait on. Only `cursor/task` was observed live.

### Process ownership, installation, and account usage

**Mapped:** OAR owns the spawned process. Disposal cancels active work, kills
the process (no `session/close` is advertised), and disposes hosted
terminals; a dispose after an observed exit is answered `accepted` without
further work. On POSIX the process leads its own process group, and a runtime
still running a grace period after SIGTERM (10 s, or `OAR_KILL_GRACE_MS`) is
SIGKILLed with its group. Persisted native sessions are not deleted.

[Installation detection](../../packages/oar/src/runtimes/cursor/installation.ts)
checks `OAR_CURSOR_BIN`, PATH `cursor-agent`, and `~/.local/bin/cursor-agent`
(the installer's link into `~/.local/share/cursor-agent/versions/<version>/`),
probing `cursor-agent acp --help` with 30 second timeouts. The installer also
links `agent`, a name too generic to probe. There is no Windows candidate.

Account usage is **unexposed**: OAR has no Cursor account usage query.

## Verification and open gaps

[`experiments/live-contract.ts cursor`](../../experiments/live-contract.ts)
covers the promises above on a real login: `basic`, `multi-turn`,
`tool-detail`, `busy-and-late-control`, `steer`, `queue`, `abort`,
`dispose-mid-turn`, `cursor`, `resume`, `subagent`, `kill-runtime`,
`bad-model`. [Cursor tests](../../tests/acp/acp-session-cursor.test.ts) use a
fake executable for the picker opt-in, model switch readback, effort after a
switch, the unknown model refusal, vendor request recording and refusal, and
the carried subagent updates (in wire order, with the edge; an unlisted kind
is dropped and claims no edge). The
[real-runtime CI matrix](../../.github/workflows/ci.yml) excludes Cursor.

Open gaps: the permission path when an admin overrides `--force`; the
`cursor/ask_question` and `cursor/create_plan` fallbacks live; any usage or
context report (the transport carries none); unknown resume ids; concurrent
same-id controllers; Windows installation. Keep native API capabilities,
transport limitations, OAR omissions and unexecuted checks separate when
designing or claiming support.
