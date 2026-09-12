# OpenAI Agents API: reference runtime

Reviewed **2026-09-12** from the public-beta documentation (released
2026-09-10 per the [API changelog][changelog]) and the API reference pages
linked below, plus live runs on **2026-09-12** (`gpt-6-astra`, project
API key, macOS) of
[`experiments/agents-api-probe.ts`](../../experiments/agents-api-probe.ts)
(`environment: none`, twice) and
[`experiments/agents-api-sandbox-probe.ts`](../../experiments/agents-api-sandbox-probe.ts)
(`openai_hosted`, plus a `none` session with a function tool and a
`self_hosted` run) and
[`experiments/agents-api-executor-probe.ts`](../../experiments/agents-api-executor-probe.ts)
(the `self_hosted` executor's lifecycle). **OAR has no Agents API adapter.** Claims are tagged [doc] or
[env]; where the two disagree the [env] observation is stated and the doc
claim kept for contrast. The announcement page itself returns 403 to
non-browser fetchers, so it is not cited.

This page exists for two reasons: the Agents API is the first vendor-managed
placement of a runtime OAR already wraps (Codex), so it is the concrete case
for [hard problem 15](../design/hard-problems.md#beyond-a-single-local-process);
and its object model independently corroborates several spec positions.
The [design input](#design-input-for-oar) section collects those.

## Native concepts and calling interfaces

### Core concepts

The API is organised around four objects. OpenAI runs the Codex harness
(model calls, tools, subagents, context compaction, recovery); the
application supplies input, tools, and the execution environment.

| Concept | Native meaning |
|---|---|
| Agent | Model, instructions, tools (function / `mcp` / `web_search` / `programmatic_tool_calling` / `tool_search`), `multi_agent` settings, reasoning and text options. Either inline on the session or saved via `POST /v1/agents` and referenced as `agent_id`; a per-session `agent` override replaces whole fields, it does not merge. |
| Environment | Where commands run and files live: `none`, `openai_hosted` (a Linux sandbox at `/workspace`, provisioned by OpenAI, idle-expires after one hour, not configurable), or `self_hosted` (the application runs `codex exec-server` inside its own compute; the executor registers with an environment id and a restricted `CODEX_API_KEY`, then holds an outbound WebSocket to `codex-cloud-environments.chatgpt.com`). A session can outlive its environment; the coordinator and its subagents share one filesystem. |
| Session | The durable unit: agent configuration, conversation, saved work. `status` is `idle` / `in_progress` / `requires_action` / `failed`. Carries `required_actions` (`function_call`, `environment_connection`), cumulative `usage`, `environment`, and `metadata`. |
| Turn | One cycle of work. `status` is `queued` / `in_progress` / `waiting` (blocked on the application) / `completed` / `failed` / `cancelled`. Carries `subagent_id` (null for the root agent), best-effort `usage`, and `error`. Listed and retrieved via `/sessions/{id}/turns`. |
| Item | Saved output, paginated (`after` / `limit` / `order`, `has_more` / `last_id`). Types: `message`, `reasoning`, `function_call`, `function_call_output`, `mcp_call`, `command_execution`, `web_search_call`, `agent_message`, and the subagent coordination calls `create_subagent_call`, `send_subagent_input_call`, `wait_for_subagents_call`, `interrupt_subagent_call`, `resume_subagent_call`, `close_subagent_call`. Root items live under `/sessions/{id}/items`; each subagent has its own history under `/sessions/{id}/subagents/{sid}/items` and per-turn items. |
| Event | Both directions. **Input events** are POSTed to `/sessions/{id}/events`: `agent.session.input.message`, `agent.session.input.cancel`, `agent.session.input.tool_result`. **Output events** are streamed (SSE, header `OpenAI-Beta: agents=v1`) from `GET /sessions/{id}/events?stream=true`, or from `POST /sessions` with `stream: true` for the first turn. |
| Subagent | Created by harness-supplied tools when `agent.multi_agent.enabled` is true (`max_concurrent_subagents`, default 6). Object: `{id, session_id, name, instructions, parent_agent_id, status, opened_at, closed_at}`. Subagents inherit MCP tools and web search, share the environment, and cannot use function tools. |
| Webhook | Content-free state notifications for `agent.session.created` / `action_required` / `in_progress` / `idle` / `failed`; the handler must retrieve the session to learn details. |

Sources: [overview][overview], [sessions][sessions], [events and items][events],
[manage][manage], [webhooks][webhooks], [multi-agent][multi-agent],
[environments][self-hosted], [environment lifecycle][lifecycle],
[observability][observability], [tracing][tracing], [functions][functions],
[MCP][mcp], [streaming events reference][ref-events],
[session resource][ref-session], [turn resource][ref-turn], [items list][ref-items].

### The output event vocabulary

Thirty event types are documented. Every event carries `event_id`; most
carry `session_id` and a nullable `turn_id`; text and reasoning deltas add
`item_id` / `output_index` / `content_index`.

| Group | Events |
|---|---|
| Session lifecycle | `agent.session.created`, `.in_progress`, `.idle`, `.requires_action`, `.failed` (each carries the full session object) |
| Environment | `agent.session.environment.pending`, `.ready`, `.connected`, `.disconnected`, `.failed` |
| Turn lifecycle | `agent.session.turn.created`, `.in_progress`, `.completed`, `.failed`, `.cancelled` (each carries the turn object; the three terminal ones also carry `usage`) |
| Items | `agent.session.turn.item.added`, `.item.done`, `.content_part.added`, `.content_part.done` |
| Text and reasoning | `agent.session.turn.output_text.delta` / `.done`, `agent.session.turn.reasoning_summary_part.added` / `.done`, `agent.session.turn.reasoning_summary_text.delta` / `.done` |
| Command output | `agent.output.command_execution_output.delta` |
| Subagents | `agent.session.subagent.created`, `.active`, `.closed` |
| Stream | `error` |

No event carries a sequence number, and no reference page mentions a
cursor, `Last-Event-ID`, or replay. The documented position is explicit:
"Streams do not replay missed events." Recovery is a procedure the
application runs: open a new stream, buffer, list items, restore state
keyed by item id, drop buffered updates for items already final, resume.
[doc: events] [env]: the SSE carries no `id:` lines and `event_id` values
are random, not orderable; there is nothing to resume from. `POST /sessions`
with `stream: true` closes with EOF after the first turn's
`agent.session.idle`; later turns need a separate `GET …/events?stream=true`.

[env] Stream order is not causal order. In the subagent run,
`agent.session.subagent.created` arrived before the root
`agent.session.turn.created` that spawned it (and arrived twice, the second
copy with `instructions` filled in), and `agent.session.subagent.closed`
arrived before the `create_subagent_call` item was added. The coordination
items came as one burst seven seconds after the subagent was created, after
it had closed.

### Control semantics

- **Prompt and steer are the same message.** "A message sent to an idle
  session starts a new turn. A message sent during an active turn steers
  that turn." The server adjudicates by its own state; the caller gets no
  precondition (contrast codex `turn/steer {expectedTurnId}`). [doc: sessions]
  [env]: the steer lands at the next step boundary, like claude. With a
  sandbox, a message POSTed while `sleep 25; echo FIRST` ran was absorbed
  into the same turn: the second command never ran, the final text was the
  steered reply, the steer message item sits in that turn, no new
  `turn.created`. Without a step boundary (a 40-line count in one
  generation) the same POST ran as the next turn instead. Both cases answer
  202 with an empty body, so the caller cannot tell which happened until
  the stream shows it.
- **Cancel is an input event**, `agent.session.input.cancel`, on the same
  endpoint as messages. The outcome is `agent.session.turn.cancelled`.
  [doc: sessions] [env]: cancelling a running `sleep 120` gave `item.done`
  with the command `status: "incomplete"`, then `turn.cancelled` 4.2 s after
  the POST, then `idle`; the turn retrieves as `cancelled` with `error`
  null, and the incomplete command item was not found in the items list
  afterwards. A cancel on an idle session is a 202 with an empty body and no
  event (three observations). There is no typed rejection.
- **Queue, undocumented.** The lifecycle page states that the input-time
  connection wait "does not provide a durable input queue" and that the API
  "does not guarantee recovery of pending input after a process crash".
  [doc: lifecycle] [env]: a mid-turn message was nonetheless held server-side
  and run as the next turn, so for an idle-or-running session the runtime
  does queue; the doc caveat is about the environment-connection wait.
- **Turn end is the turn event, never idle.** "An idle session alone does
  not mean the turn succeeded" and "a completed turn does not guarantee
  every tool succeeded" are repeated on three pages. [doc: sessions, events, webhooks]
- **Runtime-to-app requests are session state.** A function tool call
  surfaces as `agent.session.requires_action` plus `session.required_actions
  [{type: function_call, turn_id, call_id, name, arguments}]`; the turn sits
  in `waiting`; the app answers with `agent.session.input.tool_result
  {turn_id, call_id, success, output | error}`. `environment_connection` is
  the second required-action kind. [doc: functions, manage]
- **Runtime→app requests, observed.** [env]: with a declared function
  tool, `agent.session.requires_action` arrived with `session.status:
  requires_action`; the retrieved session listed `required_actions:
  [{type: function_call, turn_id, call_id, name, arguments}]` and the turn
  retrieved as `waiting`. `{type: agent.session.input.tool_result, turn_id,
  call_id, success: true, output: "<string>"}` was accepted (202) and the
  turn completed with `function_call` + `function_call_output` items.
- **Environment events are late.** [env]: on an `openai_hosted` session the
  first `turn.created` came at 9.9 s and the command had run and completed
  before `environment.ready` (30.9 s) and `environment.connected` (33.6 s)
  arrived. A reopened stream re-emits `environment.ready` first.
- **Reconnect delivers an item snapshot, not the deltas.** [env]: closing
  the stream mid-command and reopening 5 s later delivered the turn's
  existing items (`item.added` for the user message and the running
  command) and then live events, but none of the missed
  `command_execution_output.delta` lines, and no further output deltas at
  all on the new stream; `item.done` carried the full output.
- **Command output can lose its first line.** [env]: twice the first line
  a command printed (immediately at start) was absent from both the deltas
  and the saved item's `output`; a line printed 25 s in arrived. Not in
  the docs; treat command output as approximately, not exactly, verbatim.
- **Artifacts.** [env]: `GET /sessions/{id}/artifacts` lists files the turn
  left under `/workspace/outputs` with `turn_id`, `path`, `size_bytes`.
- **Reasoning summaries.** [env]: `reasoning: {effort: medium, summary:
  auto}` produced no reasoning events on a trivial task, but a `reasoning`
  item with `reasoning_summary_part.added` / `reasoning_summary_text.delta`
  / `.done` events did appear when the model had something to decide (after
  an executor died mid-command). The `reasoning` view is real but sparse.
- **Environment connection is a required action, and the input request
  blocks on it.** [env] (self-hosted): input sent with no executor gives
  `agent.session.requires_action` in 1.8 s with
  `required_actions: [{type: environment_connection, environment_id}]`,
  and the `POST /events` itself stays open until an executor connects
  (202 after 10.4 s here). A client whose proxy cuts that request loses the
  input for good: the session then answered a late executor with `idle` and
  no turn. When the executor connected in time, the parked input ran
  without resubmission; the stream showed `requires_action`,
  `environment.connected`, `idle`, then `turn.created`.
- **Executor death is a failed tool, not a failed turn.** [env]: SIGKILL
  on the executor 5 s into `sleep 40` produced `environment.disconnected`
  20.6 s later, the command `item.done` with `status: failed` and output
  "exec-server transport disconnected; failed to resume exec-server
  session: recovery timed out after 25s", then reasoning, an honest reply,
  and `turn.completed` 51.6 s after the kill with `turn.error` null. A
  replacement executor on the same environment id connected about 80 s
  after starting and every later command ran through it.
- **Deletion leaves the executor running, and some sessions cannot be
  deleted.** [env]: `DELETE` with the executor connected returned 200, the
  stream ended with EOF, and the executor process was still alive 15 s
  later. A self-hosted session whose first turn never ran answers `DELETE`
  with 409 `conflict_error` "session has no durably bound CCA root", also
  after a cancel and after an executor was connected to it; it lingers.
- **Compaction is invisible.** The overview promises summarisation of
  previous work; no event or item type in the reference reports it. [doc: overview, ref-events]
- **Usage is best-effort and mutable.** Turn and session usage "can be
  null when unknown, and recorded counts may change as accounting arrives.
  Missing usage does not mean zero usage." Per-agent counts "cover the
  agent itself; they do not include its subagents", and the tracing example
  shows the three agent totals summing to the session total. [doc: observability, tracing]
  [env]: `usage` was null on every terminal turn event (8 of 8). Retrieved
  turns had usage for some turns and null for others, and which turns had it
  changed between reads seconds apart; the session's own `usage` read null
  after four completed turns. The subagent's turn, read from its own turns
  endpoint, carried usage.
- **Model is mandatory.** [env]: omitting `agent.model` without `agent_id`
  is a 400 (`agent.model is required when agent_id is omitted`); with a
  model given, `session.agent.model` echoes it on `agent.session.created`.
- **Delete is silent on the stream.** [env]: `DELETE /sessions/{id}` returns
  200 and an open event stream ends with a clean EOF: no event, no `error`.

### Subagent attribution

The documentation describes attribution fields on the records themselves:
`turn.subagent_id` on turn events (null = root), `subagent.parent_agent_id`
on `agent.session.subagent.created`, `agent_id` on `create_subagent_call`
items, and `sender_agent_id` / `recipient_agent_id` on `agent_message` and
`send_subagent_input_call`. It also warns that coordination items "can
omit message content" and that "the stream does not provide a full
conversation transcript" of subagents. [doc: multi-agent, observability]

[env] The root stream is thinner than that reads. In a one-subagent turn:

- no turn event with a non-null `subagent_id` reached the root stream, so
  the documented `turn_id → subagent_id` lookup has nothing to key on
  there; the subagent's turn (with usage) exists only under
  `/sessions/{id}/subagents/{sid}/turns`, and the session-level turns list
  holds root turns only;
- zero subagent `output_text.delta` events; the subagent's own messages
  are under `/sessions/{id}/subagents/{sid}/items` (a `user` message with
  its instructions and an `assistant` reply);
- what did arrive: `subagent.created` / `.closed`, and the coordination
  items (`create_subagent_call` with `agent_id`, `agent_message` in both
  directions with `sender_agent_id` / `recipient_agent_id`,
  `wait_for_subagents_call`, `close_subagent_call`), with content present
  in this run, flushed as a burst after the subagent had closed.

So the live stream shows that a subagent existed and what was exchanged
with it, not what it did. Its work is a separate paginated resource read
after the fact.

## High-level mapping to OAR

These are **prospective** correspondences against today's
[Session contract](../../packages/oar/src/contracts/session.ts), not
adapter behavior. Rows marked *gap* need a contract decision, not just code.

| Native concept | Prospective OAR counterpart |
|---|---|
| Session id (`sess_…`) | `Session.id`; `SessionOptions.resume` reattaches by id with a fresh stream at seq 0, which is what the spec already promises. No history rebuild: items are a different granularity from events, so "same record replayed twice gets the same seq" is unsatisfiable across a reattach and must not be claimed. |
| Installation | *gap*. Neither `executable` nor `bundled` fits: availability is "an API key with `api.agents.*` permissions is present". `InstallationSnapshot` needs a remote variant, or the probe reports `bundled` and auth failures surface at session start. |
| `SessionOptions.cwd` | *gap*. Meaningless for `none` and `openai_hosted` (always `/workspace`); for `self_hosted` it is the `workspace_directory` of an executor the host runs. The environment choice is a session option OAR does not have. |
| `prompt()` | `POST /events [input.message]` while the adapter's own fold says idle; the 202 reply is the `accepted` response. The kernel's ≤1-active-turn rule must be enforced locally, because the server accepts a mid-turn message with the same 202 and runs it later ([env]) instead of rejecting `busy`. Turn end: the root `agent.session.turn.completed` / `.failed` / `.cancelled` becomes the `turn_ended` view (`completed` / `failed` / `aborted`). |
| `steer()` | `capabilities.steer: true`: [env] a mid-turn message is absorbed at the next tool boundary into the same turn. The same POST on a turn with no further step runs as the next turn; the 202 is identical in both cases, so `accepted` means delivered, and where it landed is read off the stream (a later `turn.created` with the message as its first item = queued). This is the claude landing rule, not codex's `expectedTurnId` precondition. |
| `queue()` | The runtime holds input it cannot steer and runs it as the next turn ([env]), so a `queue()` call would be the same POST: `capabilities.queue: { durable: true }` (server-side). The lifecycle page's "no durable input queue" concerns the environment-connection wait. The queued turn has no prompt request of its own: a spontaneous turn, the shape codex's native queue already produces. |
| `abort()` | `POST /events [input.cancel]`; 202 is `accepted`, outcome is the runtime's `turn.cancelled` (4 s after the POST on a running command, preceded by the command item going `incomplete`). [env] a cancel with nothing active is also 202 and produces nothing, so "rejected: no active turn" must be the adapter's own local decision, not the server's. |
| Output events | One event record per SSE event, `type` = the event's `type`, `native` verbatim, `spanId` = `turn_id`. Views: `output_text.delta` → `text_delta`; `reasoning_summary_text.delta` → `reasoning`; `item.added` for `command_execution` / `mcp_call` / `function_call` / `web_search_call` → `tool_call_started`, `item.done` → `tool_call_ended`; terminal turn events → `turn_ended` + `usage`; `agent.session.created` → `model` (from `session.agent.model`). Everything else is an event with no views. |
| Runtime→app requests | `agent.session.requires_action` with a `function_call` is a `toApp` request; the app's `tool_result` is its response. An adapter declaring no function tools never receives one. `environment_connection` has no OAR counterpart today (*gap*, see placement). |
| Sub-agents | [env] the root stream carries no subagent turn events, no subagent text, and (with a sandbox) no subagent `command_execution` items; only `subagent.created` / `.closed` and coordination items whose `sender_agent_id` / `recipient_agent_id` name the parties. The subagent's command, its output, and its turn with usage exist under `/subagents/{sid}/items` and `/turns`. Records that do name a subagent can carry `agentPath = [subagent_id]`, but the subagent's own work is not on the stream: that is the `opaque` tier with a labelled edge, closer to kimi than to codex. `usage().byAgent` cannot be a fold. |
| `contextUsage()` | Always null: no context-window figure is exposed. |
| `dispose()` | *gap*. The session has no process, so nothing exits on its side. "Release the runtime" can only mean closing the SSE subscription; the session persists remotely and stays billable if its sandbox is alive. `DELETE /sessions/{id}` is a separate, destructive act that [env] leaves a connected local executor running and is refused (409) for a session that never ran a turn. In the hybrid shape the adapter does own one process, the executor, and its exit is an `environment.disconnected` on the session ([env], 20 s later), not the session's end. The `exited` response is a local-process concept; the nearest remote analogue is `agent.session.failed`, and a stream disconnect is explicitly not death. |
| Cursor | Within the adapter process, the retained log honours `afterSeq` as usual. A live-stream disconnect inside that lifetime loses events the server will not replay ([env]: no SSE ids, random `event_id`; a reopened stream sends an item-level snapshot and then stops delivering output deltas). The snapshot's `item.added` frames are runtime frames and can be recorded as events, but they are a restatement, not the missed deltas; the adapter must not present them as if nothing was lost. How to mark the gap honestly on the stream is open (see below). |
| Usage views | [env] terminal turn events never carried usage, so a `usage` view cannot come from the stream. A truthful adapter emits none and leaves `usage()` null, or polls the turn resource after the fact and records the answer as its own observation, not as a runtime event. |
| `listModels` / `accountUsage` | Not part of the Agents API; `/v1/models` and the platform dashboard respectively. |

## Design input for OAR

What the Agents API confirms, and what it adds, relative to the
[spec](../spec/README.md) and [design](../design/README.md) pages.

### Confirmations

1. **Control as records on one channel.** Messages, cancels, and tool
   results are `agent.session.input.*` events on the same `/events`
   resource the outputs stream from. A fourth independent vendor for
   [record-stream.md, Evidence B](../spec/record-stream.md).
2. **Turn end is the runtime's own event; idle is not success.** Matches
   the "no synthesized turn boundaries" rule and status-as-fold.
3. **No cursor means application-side recovery.** "Streams do not replay
   missed events" plus an item-keyed dedupe procedure is exactly the cost
   [session-graph-and-cursor.md](../spec/session-graph-and-cursor.md)
   predicts, now from the largest vendor rather than from kimi-cli's
   replay-everything.
4. **Attribution is a field on the record, same stream.** `subagent_id` on
   turns and `parent_agent_id` on subagents; no second transport. Leaf-only
   per-agent usage that sums to the session total is the contract's
   "deduplicated, directly summable" shape.
5. **Runtime→app requests carry their own identity** (`turn_id` +
   `call_id`), answered on the same channel, with the turn parked in
   `waiting`. Same obligation split as OAR's `toApp` request / `answered`
   response.

### Additions the contract does not yet answer

1. **Environment is a first-class object, separate from the session.** A
   session outlives its environment; connection is a required action the
   app must satisfy; `cwd` is not universal. This is
   [hard problem 15](../design/hard-problems.md#beyond-a-single-local-process)
   made concrete and belongs in the next `SessionCapabilities` revision
   ([open decision 3](../spec/README.md#open-decisions)).
2. **Release is not termination.** `dispose` currently bundles "stop
   observing", "interrupt", and "the runtime is gone" because every shipped
   adapter owns a process. A remote session splits them, and the `exited`
   response needs a stated meaning (or an honest absence) for runtimes that
   never exit.
3. **A lossy live stream inside the adapter's lifetime.** Today the only
   in-lifetime loss OAR knows is grok's unattached serve mode. Here a
   reconnect is routine and the server discards. The stream needs a way to
   say "records were not observed between here and here" without
   synthesizing them; the current record kinds have no such marker.
4. **Usage facts can be revised.** OAR treats a `usage` view as a fact at
   its `seq`. The Agents API says counts may change after the turn ends and
   arrive only on later resource reads. A fold over the stream is honest
   only if it never claims finality; a later correction can only enter the
   stream as a new event if something polls, which OAR does not do.
5. **Compaction happens and is not reported.** External compaction continuity
   is now defined by the [record-stream spec](../spec/record-stream.md): a new
   session's first prompt carries the summary and optional host lineage;
   runtime-native compaction remains an adapter evidence question.
6. **Steer without a precondition.** Prompt and steer share one wire
   message, disambiguated by server state, so the busy/steer race is
   adjudicated remotely with no typed refusal. Evidence for keeping OAR's
   explicit `steer` with `not_steerable` rejection rather than adopting the
   simpler shape.
7. **Pushed liveness.** Webhooks deliver session state changes (including
   `failed`) with no stream open. For [liveness.md](../design/liveness.md)
   this is a runtime that can report "why" without being asked, the
   opposite of inference from silence; it also shows content-free
   notification plus retrieve as a viable pattern.

## Adapter shape, if built

The [development guide](../development.md#how-to-add-a-new-runtime) rule
applies: probe first, then build on the observations. The shape that fits
OAR's coding-agent use best is a hybrid: the session is remote, and OAR
spawns `codex exec-server` locally in `cwd` as the `self_hosted` executor.
That restores meaning to `cwd`, `env`, and process exit (the executor's,
not the session's), at the cost of needing two credentials (the project API
key and a restricted environment key). `none` and `openai_hosted` would be
explicit environment options for hosts that want them.

Transport needs no SDK: `fetch` plus an SSE parser (undici is already a
dev dependency, Node 24 has `fetch`; set `NODE_USE_ENV_PROXY=1` where the
shell relies on a proxy, since Node's `fetch` ignores it). The two probe
scripts' headers hold the observations; the ones that fix the adapter's
declared capabilities are: `steer: true` (lands at a tool boundary, else
runs as the next turn), `queue: { durable: true }` (server-side), no typed
rejection for a stray cancel, no usage on the stream, and an
`opaque`-with-edges subagent tier.

The self-hosted hybrid works end to end. [env] A local
`codex exec-server --remote <environment.remote_url> --environment-id <id>`
(codex 0.154.0) authenticating with the project key is refused with
`403 Forbidden: missing required scope api.agents.environments.connect`;
with a restricted environment key (created on the platform's Agents tab) it
registered, `agent.session.environment.connected` was the first event on
the session stream, and the turn ran `/bin/zsh -lc 'pwd && ls | head -5 &&
echo LOCAL-OK'` in this repository's `cwd` with complete output. The
registration URL has the shape
`https://api.openai.com/v1/agents/api/connect/rt_<id>`; the executor is
silent on stdout and stderr while connected. So an OAR adapter would carry
two credentials and own one local process (the executor). The executor
lifecycle is pinned ([env], executor probe): start it before the first
input or accept that the input request blocks until it connects; its
death mid-command surfaces as `environment.disconnected` plus a `failed`
command item inside a turn that still completes; a replacement on the same
environment id reconnects in about 80 s; and `DELETE` does not stop it, so
the adapter kills it on dispose.

Still open: the one observed loss of a 202-accepted message in the
completed-but-not-idle window (first sandbox run) did not reproduce in
five deliberate attempts, so it stays a single unexplained occurrence; how
compaction manifests on a long session; and whether `agent.session.failed`
is ever followed by anything on the stream.

[changelog]: https://developers.openai.com/api/docs/changelog
[overview]: https://developers.openai.com/api/docs/guides/agents-api/overview
[sessions]: https://developers.openai.com/api/docs/guides/agents-api/sessions
[events]: https://developers.openai.com/api/docs/guides/agents-api/sessions/events
[manage]: https://developers.openai.com/api/docs/guides/agents-api/sessions/manage
[webhooks]: https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks
[multi-agent]: https://developers.openai.com/api/docs/guides/agents-api/multi-agent
[self-hosted]: https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted
[lifecycle]: https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle
[observability]: https://developers.openai.com/api/docs/guides/agents-api/observability
[tracing]: https://developers.openai.com/api/docs/guides/agents-api/tracing
[functions]: https://developers.openai.com/api/docs/guides/agents-api/tools/functions
[mcp]: https://developers.openai.com/api/docs/guides/agents-api/tools/mcp
[ref-events]: https://developers.openai.com/api/reference/resources/beta/subresources/agents/streaming-events
[ref-session]: https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/methods/retrieve
[ref-turn]: https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/subresources/turns/methods/retrieve
[ref-items]: https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/subresources/items/methods/list
