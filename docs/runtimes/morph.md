# Mister Morph

Evidence baseline: native source
[`quailyquaily/mistermorph`](https://github.com/quailyquaily/mistermorph)
at `319fa4b8`, the commit that added the `POST /topics` this adapter needs
(reviewed 2026-10-04), its [Runtime API guide](https://github.com/quailyquaily/mistermorph/blob/master/docs/runtime-api.md)
and the Control OpenAPI document beside it. Live observations come from a
`morph dev` build's Console, profile `codex` (`gpt-5.6-luna`), 2026-10-04,
through [`experiments/morph-runtime-probe.ts`](../../experiments/morph-runtime-probe.ts).
The shared behavior suite (`OAR_TEST=morph`) and `live-contract.ts` have
**not** been run against a real Console yet; see
[evidence](#evidence-and-verification). Versions are evidence baselines, not a
support range.

## Native concepts and calling interfaces

Mister Morph is a desktop app, CLI and Go runtime for one agent with many
conversations. Its **Console** (`morph console`) is a long-lived local server
that owns one state directory (default `~/.morph`, `file_state_dir` in its
config): it takes `console/owner.lck` there, so only one Console runs per
directory, and a second `morph console serve` refuses to start.

Inside Console:

- a **topic** is one persistent conversation (its id is a UUIDv7); its
  history and model context survive restarts, and it can have a **workspace**
  directory attached, where its tools run;
- a **task** is one submission into a topic, with its own id and a status
  (`queued`, `running`, `pending` on an approval, then `done`, `failed` or
  `canceled`); the agent run behind a task is a sequence of LLM steps and tool
  calls;
- an **LLM profile** is a named provider/model configuration; a task may name
  one (`llm_profile`), otherwise the default profile runs;
- an **approval** is a guarded tool call waiting for a decision.

Calling surfaces: `morph run` (one-shot CLI, no topics, no control),
`morph chat` (terminal UI over the same topics), Console's **Runtime API**
(HTTP + JSON with a Bearer token, plus a WebSocket progress stream), and
channel runtimes (Telegram, Slack, ...). Morph is an ACP *client* only; it
does not serve ACP. OAR uses the Runtime API.

While Console runs, it publishes a loopback Runtime API endpoint and a private
token in `<state>/console/runtime.json`
([local_chat.go](https://github.com/quailyquaily/mistermorph/blob/master/cmd/mistermorph/consolecmd/local_chat.go));
`morph chat` and `morph console stop` find it there. That endpoint serves the
whole Runtime API without the user configuring `server.auth_token`.

## High-level mapping to OAR

| Native concept or owner | Current OAR mapping |
| --- | --- |
| Console process | Not the session's process. The adapter attaches to the Console published for the state directory, or starts `morph console serve --console-listen 127.0.0.1:0` in that directory when none answers; a started Console is shared by every session of this OAR process on the same directory and stopped with the last one ([console.ts](../../packages/oar/src/runtimes/morph/console.ts)). A Console the user started is never stopped by OAR. |
| State directory | `MISTER_MORPH_FILE_STATE_DIR`, else a top-level `file_state_dir` in `MISTER_MORPH_CONFIG` or `~/.morph/config.yaml`, else `~/.morph`. |
| Topic | `Session.id`. A new session creates an empty topic (`POST /topics`); `resume` checks it (`GET /topics/{id}`). Both attach the session's `cwd` as the topic workspace (`PUT /workspace`). |
| Task | One turn. Its `/stream/ws` snapshots are frames (`stream/<status>`), its `GET /tasks/{id}` answers are frames when they report a new status (`task/<status>`), and the terminal one ends the turn. |
| LLM profile | `SessionOptions.model` (checked against `GET /llm/profiles` at open, sent as `llm_profile` with every task); `listModels` lists the profiles, `resolvedId` the model each names. |
| Approval | Answered `approve` automatically (sessions run YOLO), recorded as a `toApp` request (`type: "approval"`, the `ApprovalInfo` verbatim) and its `answered` response. |
| `spawn` subtasks | `capabilities.attribution: "opaque"`: they run inside the parent task, and its trace only marks their start and end. |

`capabilities` are `{ queue: { durable: false }, attribution: "opaque",
images: false }`; the session has `steer` and `withdraw`.

## Capability details

### Open, resume and release

Console has no stdio session: the adapter's HTTP calls are its only link.
Opening needs a Console whose Runtime API has `POST /topics` (mistermorph
`319fa4b8` and later); an older one answers 405 and the open fails saying so. Before that endpoint existed, a
topic was created only by the first task, which would leave `Session.id`
unknown at open.

`resume` reopens the topic with a fresh stream at seq 0; nothing is replayed.
A resume in another `cwd` re-attaches the workspace, so the topic runs where
the new session says (unlike kimi, nothing is refused). An unknown topic id
fails the open.

`dispose` records its request, stops the running task (`POST
/tasks/{id}/stop`) and waits up to 3 s for its own `canceled`, then releases
the Console: answered `exited` with the code when that release stopped a
Console OAR started, `accepted` otherwise. A started Console that dies on its
own is an `exited` response pointing at no request in every session holding
it; an attached Console that stops answering task queries (8 in a row) is
recorded the same way with code `null`.

### Prompt, steer, queue

`prompt` is `POST /tasks {task, topic_id, workspace_dir, llm_profile?}`. It is
rejected `busy` exactly when `Session.status()` says running as it is
recorded. Text is read by Console as a runtime command when it is one
(`/reset`, `/models set ...`), as in Console itself.

**Steer** is the same submission while the topic runs. Console injects plain
text into the active run and answers a completed acknowledgement task naming
`steer_target_task_id` ([env]: `steer_queued`, then `steer_applied` at the
next step, and the model honored it). The adapter answers:

- `accepted` with `steer_target_task_id` in the native answer;
- `runtime_refused` (`not_steerable: ...`) when Console found the run but did
  not hold the input (a completed acknowledgement without a target);
- `accepted` when the run had ended first: the text then started a task of its
  own, which is followed as a spontaneous turn.

`steer_applied` becomes a `user_message` event (`evidence: "conversation"`,
no `inputId`: morph names none). Text with file references or commands never
steers (Console's rule); OAR sends neither.

**Queue** is held by the adapter while a task runs and sent when the topic
goes idle (a spontaneous turn); `withdraw` removes a held entry until then.

A prompt that races the end of a run can be steered into that run by Console:
the answer names `steer_target_task_id` and the prompt's turn is that task's.

### Abort

`POST /tasks/{id}/stop` on the running task: `accepted` when Console answered
`found: true`; `no_active_turn` when nothing is running or Console found no
work. The task's terminal `canceled` (error "stopped by user", ~2 s later in
the probe) is the `turn_ended` `aborted`.

### Events, history and children

`/stream/ws` frames are **snapshots** ([env]): `text` and `reasoning` are
accumulated so far, and `trace.entries` is a bounded window of agent events,
each with a per-task `seq`. A slow reader may miss snapshots, and the stream's
`seq` is global to Console's hub, so the fold reads what is new in each
([projection.ts](../../packages/oar/src/runtimes/morph/projection.ts)):

| Native | OAR event |
| --- | --- |
| trace `tool_start` (`activity_id` = provider call id, `args`) | `tool_call_started` (`input`: a lone `cmd` as is, otherwise the args as JSON) |
| trace `tool_output` (names only the tool) | `tool_call_progress` on the newest open call of that tool |
| trace `tool_done` | `tool_call_ended`: `content` the text, `result`, `exitCode` from a leading `exit_code: N` |
| trace `llm_retry` ("Retrying in 1.0s (1/5).") | `retry` |
| trace `context_compaction_start` / `_done` / `_failed` | `compaction_started` / `compaction_ended` |
| trace `steer_applied` | `user_message` |
| `model` on trace entries and the task | `model` (on change) |
| non-preview `text` growth | `text_delta` (`messageId` `<task>:<n>`; a snapshot that does not extend the last one starts message n+1) |
| `reasoning` growth | `reasoning` |
| terminal `GET /tasks/{id}` | the trace, reasoning and `result.final.output` the stream missed, then `turn_ended` (`done` completed, `canceled` aborted, `failed` with `error` classified) |
| `GET /topic/{id}/metadata` before the end | `usage.context` from `used_input_tokens`, `context_window_tokens`, `usage_ratio` |

`text` with `preview: true` is Console's tool status line ("[bash]
running\n\nstdout: ..."), not model output; it stays in the native frame
only. The stream's `done` is a hint: Console's guide makes the task query
authoritative, and the turn ends only there. Snapshots and status changes are
the only frames; unchanged poll answers are not recorded.

Topic history from before the session is not replayed. Subtasks (`spawn`)
appear only as `subtask_start` / `subtask_done` trace entries, which carry no
event.

### Models, context and usage

The profile name is the selector; `Session.model()` reports the model Console
says ran (`gpt-5.6-luna` for profile `codex`). There is no reasoning-effort
channel on the Runtime API: an `effort` refuses the open, and `listModels`
lists no levels. Token totals are not reported: `result.metrics.total_tokens`
has no input/output split, so `usage().total` stays null rather than guess.
Context fullness is the topic metadata above.

### Options

Refused at open (`refusedSessionOptions`): `systemPrompt` and
`appendSystemPrompt` (no override on the API), and `env` (tools run inside
the Console process, which the session neither starts nor owns). Because it
refuses `env`, morph cannot be an `oar mcp` subagent. Images are not
supported (`capabilities.images: false`); the API's `file_references` upload
path is not used.

A Console OAR starts runs the user's whole Console configuration, including
any channel runtimes it is set up to start.

## Evidence and verification

- [env] 2026-10-04, `experiments/morph-runtime-probe.ts --profile codex`
  against a running dev Console: one tool turn, a follow-up in the same topic,
  a steer during a 6 s shell command, a stop; findings in the script's
  `OBSERVED` header. A first run on the default profile (a local proxy that
  was down) showed `llm_retry` entries and `failed` tasks with
  `llm call failed at step 0: ... connection refused`.
- Unit tests: [projection](../../tests/morph/morph-projection.test.ts) over
  the probe's shapes; [session](../../tests/morph/morph-session.test.ts)
  against a scripted Runtime API (busy, steer answers, abort, held queue,
  approval, dispose, resume, refusals, profiles);
  [Console](../../tests/morph/morph-console.test.ts) discovery, state
  directory resolution, and start/share/stop with a fake `morph` executable.
- Not yet run: `OAR_TEST=morph OAR_TEST_MODEL=<profile> pnpm sea-trial` and
  `experiments/live-contract.ts morph`. Both need a Console with
  `POST /topics`.

Open questions: whether a prompt racing the end of a run can be lost (Console
found the run but its steer queue had closed); how subtasks' tool activity
appears in the parent trace; whether Console keeps snapshots for a task whose
stream was not subscribed when it ended.
