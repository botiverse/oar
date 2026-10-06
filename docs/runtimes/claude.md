# Claude Code

Mapping claims follow current OAR source. Observations name their binary: the
live contract ([`experiments/live-contract.ts claude`](../../experiments/live-contract.ts))
ran on **claude 2.1.268** (darwin arm64, haiku, 2026-09-11); the probes on
**2.1.237** and **2.1.261** (linux x64) are listed in the
[experiments index](../../experiments/README.md); later observations carry
their version inline. The latest daily check re-ran `basic`, `tool-detail` and
`resume` on **2.1.289** (2026-10-04,
[report](../../experiments/runtime-version-checks/2026-10-04.md)). Versions
are evidence baselines, not a support range.
Tags follow the [spec conventions](../spec/README.md): `[src]` vendor source,
`[sym]` binary symbols, `[env]` observed. See the [runtime index](README.md)
for status labels.

## Native concepts and calling interfaces

Claude Code owns the agent loop, tools, context management, and persistent
conversation. A **session** is persistent conversation identity; a **user turn**
can contain multiple **model steps** and tool executions. Assistant messages
carry text, thinking, and tool-use blocks; tool results return in user-message
blocks. A result ends a user turn, not the conversation or necessarily every
native child. [Agent loop][native-loop], [streaming input][native-input].

Native **subagents** have separate conversations and can run concurrently.
The `Agent` tool invocation and `parent_tool_use_id` identify child activity;
child identity, tool-call identity, and main session identity are different
concepts. [Subagents][native-subagents].

Programs have two entry points:

- **CLI print mode:** `claude -p` supports structured output and bidirectional
  `stream-json`; a long-lived process accepts multiple user turns. OAR uses
  this interface. [CLI reference][native-cli].
- **Claude Agent SDK:** TypeScript `query()` exposes an async message stream;
  SDK APIs add configuration, callbacks, session discovery, history
  retrieval, and fork. OAR does not use the SDK.
  [SDK sessions][native-sessions], [permissions][native-permissions].

## High-level mapping to OAR

| Native concept or interface | OAR mapping (record stream) |
|---|---|
| CLI process | One owned subprocess per OAR Session; stdio carries inputs, controls, and frames. Its exit is an `exited` response record (answering `dispose` when OAR caused it). |
| Persistent session ID | `Session.id`, passed as `--session-id` or `--resume`. Every record carries it as `sessionId`. |
| stream-json frame | One `Frame` record per stdout line (control traffic below and the effort read-back at open are the exceptions): `type` = `type[/subtype]`, `native` = the frame verbatim, `events` = OAR's readings (text_delta, reasoning, tool_call_started/ended, user_message, turn_ended, usage, model, task_*, compaction_ended). Frames OAR does not interpret (`rate_limit_event`, `system/thinking_tokens`, …) carry no events. No `spanId`: claude frames carry no turn id. |
| User turn and `result` | The `prompt` request record starts the turn; the `result` frame ends it with a `turn_ended` event (`aborted` while OAR's own interrupt is outstanding, `failed` on `is_error`, else `completed`) plus a `usage` event. |
| Subagent messages (`parent_tool_use_id`) | `agentPath = [...parentPath, taskCallId]` ([details](#observation-children-and-history)); `capabilities.attribution` is `attributed`. |
| `tool_use` / `tool_result` blocks | `tool_call_started` (`callId`, `tool`, `input`) and `tool_call_ended` (`callId`, `content`, `result`): `is_error: true` is `failed`; `false` or an absent field is `ok` ([evidence](#tool-call-outcome-reporting)). |
| `control_request` / `control_response` | OAR's interrupt is an `abort` request record whose id is the `control_request` id; claude's `control_response` becomes its `accepted`/`rejected` response. A `control_request` from claude is recorded as a Frame plus an unanswered `toApp` request (none arrive under `--dangerously-skip-permissions`); `events()` reads it as `app_request` with the request subtype as `type`. |
| `system/task_*` | `task_started`, `task_updated`, `task_ended` events for commands, subagents and backgrounded MCP calls (claude moves a main-conversation MCP call past two minutes to the background). `background_tasks_changed` (the live set) and `task_progress` carry no events. |
| `system/compact_boundary` | The after-the-fact compaction report: a `compaction_ended` event, outcome `completed`, `trigger` from `compact_metadata.trigger` (`manual` \| `auto`). The frame carries `compact_metadata { trigger, pre_tokens, post_tokens?, cumulative_dropped_tokens? }` [sym 2.1.272]. claude has no start frame, so no `compaction_started`, no `retry` (401s are retried silently) and no `tool_call_progress` (tool output arrives whole in the `user` tool_result frame). |
| SDK configuration and interaction APIs | Only `--model`, `--effort` (confirmed by `get_settings` at open) and the system prompt flags. |

Sources: [adapter](../../packages/oar/src/runtimes/claude/session.ts),
[projection](../../packages/oar/src/runtimes/claude/projection.ts),
[task frames](../../packages/oar/src/runtimes/claude/tasks.ts),
[Session contract](../../packages/oar/src/contracts/session.ts).

## Capability details

### Session creation and resume

OAR's resume call:

```sh
claude -p --input-format stream-json --output-format stream-json --verbose \
  --replay-user-messages --dangerously-skip-permissions --resume SESSION_ID
```

A new session passes `--session-id UUID` (OAR's `randomUUID()`) instead.
OAR then writes newline-delimited frames such as
`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Continue"}]}}`.
The SDK equivalent is `query({ prompt: "Continue", options: { resume: sessionId } })`;
`forkSession` instead creates a new identity from existing history.
[CLI reference][native-cli], [SDK sessions][native-sessions].

The resume token is a **native session ID**, not a turn ID or file path; its
transcript must exist under the active Claude configuration home. Native
documentation describes cross-directory ID lookup since 2.1.223; a resume
through OAR naming another `cwd` kept the conversation and ran its shell
there (2.1.288, 2026-10-03, [resume in another directory](resume-cwd.md)).
Resume restores context for new requests, not a prior process.
[SDK sessions][native-sessions].

**Mapped:** `await claudeSession(installation, { cwd, resume: sessionId })`
resolves once the process is spawned (and, with `effort`, once `get_settings`
confirms it), **before any native resume acknowledgment**; the resumed stream
starts empty (claude says nothing until the first turn). A resumed session
keeps the id and recalls the earlier transcript (same cwd), but only a
prompt's outcome establishes that history was restored. The reopened adapter
has fresh observers, sequence numbers, and an empty queue; it takes startup
options again and restores neither old control handles nor historical OAR
records. [Adapter](../../packages/oar/src/runtimes/claude/session.ts),
[kernel](../../packages/oar/src/shared/session-kernel.ts).

Fork, session listing, history retrieval, rewind, and reset identity management
are **not exposed**. Missing-ID error timing, duplicate transcripts, and
concurrent controllers resuming one ID are **unverified**.

### Prompt, steering, queueing, and abort

**Prompt (mapped):** `prompt(string)` records a `prompt` request and answers
it `accepted` once the user message is on stdin, or `rejected` `busy` while a
turn is active. A `system/init` arriving while nothing is active is a
spontaneous turn (a drained queue message): events but no request of its own.
A basic turn's frames are `system/init`, several `system/thinking_tokens`, a
`rate_limit_event` (not on every turn), one `assistant` frame per content
block (thinking, then text) and `result/success`, plus the prompt's `user`
echo that `--replay-user-messages` adds; the number of frames varies from
turn to turn. The [multi-turn fixture](../../tests/replay/fixtures/claude-multi-turn.raw.jsonl)
holds two such turns, recorded without the echo.
[Projection](../../packages/oar/src/runtimes/claude/projection.ts).

**Steer (mapped, landing observed):** `steer()` writes stdin and records
`accepted`, which hands delivery to the adapter and does not prove model
receipt. In multi-step turns claude absorbs the input at the next model step:
a steer issued after the first `tool_call_started` of a two-tool turn landed
in the same turn's final text with one `turn_ended`. Input arriving after the
last step becomes a subsequent turn.

**Input identity:** the input's `inputId` is the stream-json message `uuid`,
and OAR passes `--replay-user-messages`; the echo becomes a `user_message`
event (`evidence: "acknowledged"`), separate from evidence of model
consumption. The [conversation contract](../spec/conversation.md) owns echo
mapping, including steer → queue fallback; the
[steer delivery probes](steer-delivery.md) hold the native observations.

**Images (mapped):** `InputOptions.images` become base64 `image` content
blocks ahead of the text block in the stdin user message (prompt, steer and
queue alike); claude forwards them to the Messages API unchanged
([vendor test](../../sea-trial/vendor/images.vendor.test.ts)). Live (claude
2.1.284, 2026-09-29): asked the color of a plain green PNG named `probe.png`,
it answered `green`. The echo's `user_message.input` stays the text alone.

**Queue (mapped):** `queue()` is adapter-held (`capabilities.queue.durable:
false`), drained one message per turn end; the queued input runs as a
spontaneous turn with no prompt request of its own. A queue while idle is
written at once. `withdraw(inputId)` takes a held message back before a turn
end writes it (`accepted`) and answers `not_queued` once it is on stdin;
claude's own `cancel_queued` markers stay unmapped
([input cancellation](input-cancellation.md),
[test](../../tests/claude/claude-session-withdraw.test.ts)).

**Abort (mapped):** `abort()` records an `abort` request whose id is the
`control_request` id and sends `control_request/interrupt`; claude's
`control_response` (`still_queued: []`) is that request's `accepted`
response, and the turn ends on claude's own `result/error_during_execution`,
which the fold classifies `aborted` because OAR's interrupt was outstanding.
A late abort is rejected `no active turn`.

**Unreachable runtime:** a `dispose` mid-turn ends with `request dispose`,
`response exited` (code 143) and no `result` frame, so the turn end for
observers is the exit itself. When claude dies on its own (SIGKILL), the
stream gets `response exited` with `requestId ""` and code `null`; the kernel
then rejects every prompt/steer/queue/abort `runtime exited` and answers a
later `dispose` `accepted`
([test](../../tests/claude/claude-session-death.test.ts)).
[Phase probe](../../experiments/claude-stream-json-phases.ts),
[adapter probe](../../experiments/claude-session-adapter.ts),
[queue probe](../../experiments/session-queue.ts).

### Observation, children, and history

**Mapped:** every JSON frame enters the stream verbatim in `native` (of a
Frame, or of the response record for a control reply), except the effort
read-back answer the adapter consumes at open, so message identity, input
echoes, control replies and telemetry are there even where OAR has no event
for them. Text blocks become `text_delta` events naming the API message
(`messageId` = `message.id`); reasoning keeps the text, redacted, and empty
distinctions; tools keep IDs and available input/output. An `assistant`
frame with several blocks is one record with several events in block order
(every recorded fixture carries one block per frame). OAR does not request
`--include-partial-messages`, so `text_delta` does not imply token-level
streaming. [Native streaming][native-output],
[projection](../../packages/oar/src/runtimes/claude/projection.ts).

**Attributed:** frames carrying `parent_tool_use_id` get
`agentPath = [...parentPath, taskCallId]`, where `parentPath` is the agent
that issued that Task call, so nested sub-agents nest the path. A Task
sub-agent's `user` and `assistant` frames arrive with that path; the root
additionally emits the `system/task_*` frames read as task events (mapping
table above), for subagents and background commands alike
([record stream](../spec/record-stream.md)). When a
background task ends while the session is idle, claude starts a spontaneous
turn of its own to handle the result [env 2.1.284]. Child records arriving
after the parent's `result` still enter the stream (nothing is gated on turn
state). There is no child control handle. No child `result` frame has been
observed, so child usage stays unattributed and `usage()` is root-only;
whether a child ever reports usage, and the interleaving of concurrent
children, are **unverified**. [Native subagents][native-subagents].

`rawEvents(observer, cursor)` replays the retained records after `afterSeq`
for the lifetime of the adapter process (a mid-turn subscribe replays exactly
the retained records and continues live; a full replay equals `records()`);
it is not a history API across processes. The
[recording helper](../../sea-trial/record/claude.ts) scrubs frames for
projection tests; it is not a public raw/replay interface.

### Models, instructions, and context

**Mapped:** `--model` selects the initial model; `model()` folds the `model`
event OAR reads from each `system/init` frame, so it is `null` until the
first turn's init frame (`haiku` reads back as `claude-haiku-4-5-20251001`).
Opening with a model that does not exist succeeds; the first turn fails with
claude's "issue with the selected model" message, classified
`invalid_request`. The token-free `list_models` control request preserves
selector versus resolved ID, disabled entries, and effort choices
(`supportedEffortLevels` per model; haiku lists none).
[Catalog](../../packages/oar/src/runtimes/claude/list-models.ts),
[readback probe](../../experiments/session-model-readback.ts),
[unit test](../../tests/claude/claude-session-model.test.ts).

**Effort (mapped, confirmed at open, not in the stream).** `SessionOptions.effort`
is `--effort <level>` (2.1.284: low, medium, high, xhigh, max) on a new
session and on `--resume` alike; the Messages API request then carries
`output_config: {effort}` beside `thinking: {type: "adaptive"}` (`low` on the
first turn, `high` after a resume asking for it:
[vendor test](../../sea-trial/vendor/effort.vendor.test.ts), claude-aimock).
claude keeps no effort per session: a resume without `--effort` sends its
default (`medium`) whatever the session ran before
([experiment](../../experiments/effort-channels.ts)). No frame names the
level (`system/init` carries only `per_turn_effort_active`; `assistant` and
`result` nothing). The transcript does, as `effort` / `perTurnEffort` on each
assistant message (live 2026-09-29: `low`, then `medium` after the resume),
but OAR never reads transcripts.

Three cases drop a level without a word on stdout: an unknown value only
warns on stderr (`Unknown --effort value 'bogus'`, ignoring it for the
default effort); a model without effort (haiku) sends none; and a
`maxEffortLevel` setting or `CLAUDE_CODE_EFFORT_LEVEL` can clamp or override
the flag ([sym] 2.1.284 setting docs; not exercised). So the adapter asks
claude before the session opens with the token-free `get_settings` control
request, answered once the SessionStart hooks ran (bounded at 30 s). Its
`applied.effort` is "what will actually be sent to the API", `null` when the
model takes none. Anything but the requested level refuses the open with
claude's word: `claude applies effort medium for claude-opus-5-5[1m] although
bogus was requested`, `claude sends no effort for claude-haiku-4-5-20251001
(the model takes none), so effort low would be dropped`. That answer is
consumed, not recorded, because it also dumps the merged settings of every
source (hooks, permissions, any `env` block) verbatim
([decision](../design/decisions.md#recording-claudes-effort-read-back-2026-09-29)).
`Session.effort()` therefore stays null on claude; a successful open is the
confirmation. Live model/effort changes on a running process are **not
exposed** ([native surfaces](live-configure.md)).
[Adapter](../../packages/oar/src/runtimes/claude/session.ts),
[read-back](../../packages/oar/src/runtimes/claude/effort.ts),
[unit test](../../tests/claude/claude-session-effort.test.ts).

Replace/append instructions map to `--system-prompt` and
`--append-system-prompt`; native harness metadata may remain alongside
replacement text. The vendor test checks that the configured instructions
survive manual `/compact`.
[Adapter](../../packages/oar/src/runtimes/claude/session.ts),
[vendor test](../../sea-trial/vendor/claude.vendor.test.ts).

Context reporting is **partial**. The `result` frame's `usage` event carries
input/cache counts as context fullness and the running per-agent token total
(`Session.contextUsage()` and `usage()` fold these events): across three
one-word turns `usage().value.total.input` grew by about 22k per turn (cache
reads included) while `contextUsage().value.tokens` stayed near 22k. Official
documentation describes result usage as aggregate main-loop usage for the
user turn, so the context figure is **unverified as current fullness** across
multiple model steps. Native compaction still runs and is reported after the
fact (mapping table above).
[Usage calculation](../../packages/oar/src/runtimes/claude/context-usage.ts),
[native usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

### Tools, permissions, and extensions

Native Claude supports tool selection, MCP, agents, skills, plugins,
permission modes, and SDK approval/hook callbacks. These are **not exposed**
as OAR configuration or interaction APIs. Native configuration may still
affect execution, but OAR does not pass `--mcp-config`, `--tools`, `--agents`,
or explicit setting-source controls. Startup always passes
`--dangerously-skip-permissions`; there is no OAR approval request/reply
channel. [Native MCP][native-mcp], [permissions][native-permissions],
[adapter](../../packages/oar/src/runtimes/claude/session.ts).

Inventories (2026-09-16) are control queries in their own
`--no-session-persistence` process, scoped to a workspace cwd, without a
prompt: skills from `get_context_usage` skill frontmatter (view `context`),
MCP servers from `mcp_status` with bounded startup polling (view
`discovered`), and tools explicitly MCP-only from the same `mcp_status`.
[Inventory reader](../../packages/oar/src/runtimes/claude/inventory.ts),
[query contract](../spec/inventory.md),
[native probe evidence](inventory.md).

### Process ownership, environment, installation, and account usage

**Mapped:** OAR owns the spawned process; disposal settles active work, kills
the process, and waits for exit. On POSIX the process leads its own process
group, so the kill reaches the shells, tools, and MCP servers it started:
SIGTERM, then SIGKILL if claude is still running after a grace period (10 s,
or `OAR_KILL_GRACE_MS`), so disposal settles even when claude ignores SIGTERM
([process mechanics](../../packages/oar/src/shared/executable/process.ts),
[test](../../tests/session-dispose.test.ts)). The default is sized to
claude's own SIGTERM handling [sym 2.1.283]: it runs its SessionEnd hooks (a
1.5 s budget unless a hook declares a longer `timeout`, capped at 60 s) and
force-exits after max(5 s, hook budget + 5 s), at least 15 s while writes are
still pending; the claude-aimock runs exited 0.6 to 2.3 s after the SIGTERM.
A longer hook budget needs a longer `OAR_KILL_GRACE_MS`, or the SIGKILL cuts
the hooks short. The own process group also takes claude out of the
terminal's job control: a host's Ctrl-C does not reach it, so a host that
wants it stopped disposes the session. This supplies resource release, not
detached execution or a lease against other controllers. The environment
overlay applies to the child process; `CLAUDECODE` is cleared before the
overlay. [Adapter](../../packages/oar/src/runtimes/claude/session.ts).

Installation checks `OAR_CLAUDE_BIN`/PATH; update checks and upgrades are
covered in [runtime updaters](update.md). Account usage is separate from
session context: the reader runs claude with `--safe-mode` (no user hooks or
MCP servers; a CLI without the flag is `unsupported/unsupported_installation`,
and a `--help` probe that times out rejects)
and sends native stream-json `initialize` and `get_usage`
(`skip_behaviors: true`) control requests without a prompt. It reads neither
credential files nor Keychain and makes no direct provider HTTP requests.
`rate_limits_available: false` maps to `unsupported/quota_unavailable`
without guessing an authentication cause; unsupported control requests map to
`unsupported/endpoint_unavailable`. Available replies map native five-hour,
weekly, model-scoped and enabled extra-usage windows. The new process's
session totals are not account usage and are not exposed. The native API is
experimental (verified on 2.1.273); older versions can lack it. Login is
mapped [below](#login).
[Installation](../../packages/oar/src/runtimes/claude/installation.ts),
[account usage](../../packages/oar/src/runtimes/claude/account-usage.ts),
[updater](../../packages/oar/src/runtimes/claude/update.ts).

### Login

**Mapped** ([runtime login](../spec/login.md)): `login` runs
`claude auth login` (the default claude.ai subscription login; `--console`,
`--email` and `--sso` are not exposed) over pipes, with `CLAUDECODE` cleared
as for sessions. Native behavior [sym 2.1.288]: it prints
`If the browser didn't open, visit: <url>` (an OSC 8 hyperlink from 2.1.202)
and `Paste code here if prompted > ` with no newline on stdout, then races
two ends: the browser's redirect to its localhost listener, and a
`code#state` line on stdin, which the page behind the URL shows after the
sign-in. A line it cannot parse prints `Invalid code. Please make sure the
full code was copied.` to stderr and reading goes on. Success is
`Login successful.`, followed by a few seconds of telemetry flushing before
exit 0. A failure exits 1 with `Login failed: <message>` on stderr, or with a
message of its own (a suspended account, an organization or provider that
disallows the login, a managed gateway login).

OAR strips terminal escapes from both streams, relays the URL as `auth_url`,
asks a `manual_code` prompt when the paste prompt appears and again after a
stderr line that starts with `Invalid code` (not after
`Login failed: Invalid code verifier`, which is a failure), and writes the
answer (whitespace removed) to stdin only; the pasted value and its
authorization code are redacted from every reported `detail`. A failure is
`rejected` with the `Login failed:` message, or else claude's last stderr
line. On a desktop host claude also tries to open a browser, and a sign-in
finished there ends the login while the prompt is still open. claude has no
deadline of its own, so OAR stops it after 15 minutes. A successful exit, or a
deadline or abort after `Login successful.` (while claude flushes), is
confirmed with `claude auth status --json`, which is also `authStatus`:
`loggedIn` (exit 0 logged in, 1 logged out) and `email`, `subscriptionType`
and `authMethod` as the account. `auth login` arrived in
2.1.41 and reading a pasted code in 2.1.126 [doc changelog], so an older
claude is `unsupported` / `version_unsupported`. Verified against a fake CLI
that prints the 2.1.288 strings
([tests](../../tests/login/claude-login.test.ts)), and on real logins: on
2026-10-05, on a fresh Linux test machine with claude 2.1.289 and codex
0.160.0, all five manual checklist steps of [#94](https://github.com/botiverse/oar/pull/94) (commit `f7e6428`) passed.
For claude: the status read, a login with the code pasted back, and a cancel
at the paste prompt (`login cancelled`, exit 130, no process left over, the
previous login unchanged).
[Login](../../packages/oar/src/runtimes/claude/login.ts).

## Harness fact matrix

The harness investigation questions, answered for the one interface OAR
calls: print mode with bidirectional `stream-json`. Claude Code ships as a
closed binary, so there is no source to cite. Evidence labels: **source** is
OAR adapter, projection, or test code; **observed** is a recorded run or a
file inspected on a named binary version; **vendor** is native documentation
no observation here has confirmed. Baselines: claude 2.1.268 (live contract,
2026-09-11), 2.1.261 (`claude --help` on linux, 2026-09-12), 2.1.237 (a
native transcript file inspected on linux, 2026-09-12).

Two mechanisms share a root word. **Resume** is the runtime rebuilding model
context from its own persisted material. **Replay** is OAR rebuilding an
observer's event sequence from OAR's own appended stream; it does not depend
on runtime resume. The "runtime side resume material" row describes the
former only.

### Matrix columns

| Column | Claude on OAR's path | Evidence |
|---|---|---|
| Session identity | A native UUID: OAR picks it for a new session (`--session-id`), a caller supplies it through `resume` (`--resume`). It survives the OAR process ([resume section](#session-creation-and-resume)). | source [adapter](../../packages/oar/src/runtimes/claude/session.ts); observed live contract resume scenario |
| Connection identity | None at the protocol level. One spawned process is the only connection; no frame carries a connection id and there is no second client path. | source adapter; observed fixture frames carry `session_id` only |
| Transport cursor | None. Frames carry no sequence number and no turn id; `seq` is assigned by OAR's kernel and does not outlive the process. `--replay-user-messages` echoes user messages and is not a position. | source [projection](../../packages/oar/src/runtimes/claude/projection.ts), [kernel](../../packages/oar/src/shared/session-kernel.ts); vendor [CLI reference][native-cli] |
| Event stream scope | Per process: frames go to the stdout of the process that produced them; nothing is broadcast to a second reader. | source adapter |
| Runtime side resume material | The native transcript, `<sessionId>.jsonl` under the Claude config home in a per `cwd` directory. It holds message content, not OAR's stream (question 2). `--resume` feeds it back to the model as context and replays no frames to OAR. Diagnostic reference only: OAR never replays observers from this file. | observed transcript 2.1.237; source [resume section](#session-creation-and-resume) |
| Vendor claim versus evidence | Confirmed by observation: resume continuity on the same `cwd` and in another one (2.1.288), interrupt through the control channel, subagent attribution through `parent_tool_use_id`. Vendor only: print mode transcript persistence identical to interactive mode. Unverified either way: two controllers resuming one id at once, missing id error timing. Vendor quirk observed: `result` frames with subtype `success` and `is_error: true`. | this page, [open gaps](#verification-and-open-gaps) |

### Eight dimensions

1. **Entry.** `claude -p --input-format stream-json --output-format stream-json
   --verbose --replay-user-messages --dangerously-skip-permissions` plus
   `--session-id <uuid>` or `--resume <id>`, and optional `--model`,
   `--effort` (then a `get_settings` control request before the first turn),
   `--system-prompt`, `--append-system-prompt`. `CLAUDECODE` is cleared from
   the child environment. Prompts are `user` message lines on stdin. Present
   in 2.1.261 help but not on the session path: `--include-partial-messages`,
   `--fork-session`, `--no-session-persistence` (the inventory and account
   usage readers pass it), `--permission-mode`, `--permission-prompts`,
   `--mcp-config`, `--tools`, `--agents`, `--bg`, `--cloud`, `--teleport`,
   `--remote-control`. Source:
   [adapter](../../packages/oar/src/runtimes/claude/session.ts).
2. **Session and state storage.** Native identity and transcript are claude's;
   OAR's record stream is process memory behind `records()` and is gone with
   the process. OAR owns no storage. Source: kernel; observed: the transcript
   file above.
3. **Event model.** One record per stdout frame (see the
   [mapping](#high-level-mapping-to-oar)). Frame classes in one recorded tool
   round: `system/init`, `system/thinking_tokens`, `rate_limit_event`,
   `assistant` with `thinking`, `tool_use`, `text` blocks, `user` with
   `tool_result` blocks, `result/success`; plus `control_response` answering
   OAR's interrupt and `control_request` from claude. No deltas. A turn is the
   span from OAR's `prompt` request to the `result` frame; no frame names the
   turn. Source: [projection](../../packages/oar/src/runtimes/claude/projection.ts);
   observed: [tool round fixture](../../tests/replay/fixtures/claude-tool-round.raw.jsonl).
4. **Ownership and identity.** The spawning OAR process owns the child.
   Records carry `sessionId` and `agentPath`; `parent_tool_use_id` nests a
   child under the Task call that spawned it. There is no lease against
   another controller and no connection id. Source: adapter, projection.
5. **Capability honesty.** Declared `{ queue: { durable: false },
   attribution: "attributed", images: true }`, and the session has `steer`
   and `withdraw`; what an accepted steer or queue means is in the
   [steering section](#prompt-steering-queueing-and-abort).
   Source: adapter; observed: steering section.
6. **Deployment and lifecycle.** Local subprocess only. Process exit is an
   `exited` response ([unreachable runtime](#prompt-steering-queueing-and-abort));
   after it every control is rejected `runtime exited`. Hosted forms in the
   CLI (`--bg` with `attach`, `logs`, `respawn`, `rm`, `stop`; `--cloud`;
   `--teleport`; `--remote-control`) are vendor only here; OAR does not use
   them and has no evidence about their lifecycle events. Source:
   [death test](../../tests/claude/claude-session-death.test.ts); vendor
   [CLI reference][native-cli].
7. **Tools and permissions.** Always `--dangerously-skip-permissions`; no
   approval channel. Tool blocks map as in the
   [mapping](#high-level-mapping-to-oar); a `control_request` from claude is a
   `toApp` request nobody answers, and none has been observed under skip
   permissions. Source: projection.
8. **Extension points.** MCP, agents, skills, plugins, hooks, and permission
   callbacks exist natively; OAR passes none of them. OAR reads skills, MCP
   servers, and MCP tools through workspace-scoped inventory queries, and
   discovers models with the `list_models` control request. Source:
   [tools section](#tools-permissions-and-extensions),
   [models section](#models-instructions-and-context);
   [experiments](../../experiments/README.md).

### Six questions

1. **Is the native session id stable across a host restart, and can it be
   reopened?** Yes: a new process with `--resume <id>` keeps the id and the
   model recalls earlier turns, in the same `cwd` (observed, live contract)
   and in another ([resume in another directory](resume-cwd.md), 2.1.288).
   What happens for a missing id, and how fast, is unverified.
2. **Does the runtime log keep every frame or only turn snapshots?** Neither.
   The transcript inspected here (2.1.237, an interactive session, 15869
   lines) is a tree of entries linked by `parentUuid`, one entry per `user`,
   `assistant`, `attachment`, or `system` item, plus bookkeeping entries such
   as `queue-operation`. It holds full content blocks, including `tool_use`
   and `tool_result` with `is_error`, and zero `control_request`,
   `control_response`, or `interrupt` entries and zero deltas. OAR's own
   rejections (`busy`, `no active turn`) never reach claude, so they cannot
   be there. Whether print mode with `stream-json` writes the same entries is
   vendor only ([sessions][native-sessions] says print mode persists unless
   `--no-session-persistence`); it was not inspected.
3. **Is a stream rebuilt from that log isomorphic to the original?** No.
   Absent from the transcript: every OAR request and response record
   (`prompt`, `steer`, `queue`, `abort`, `dispose`, `exited`, rejections),
   the control frame pairs, `seq`, and the `system/init`, `rate_limit_event`,
   and `result` frames as frames. Recoverable: message content, tool call
   pairs with their outcome, order, and the tree. A rebuild is a subset with
   a different envelope.
4. **Can a second observer attach to the same session?** On OAR's stream,
   yes and without limit through `rawEvents` with a cursor (source, kernel;
   [observation section](#observation-children-and-history)). At the runtime
   there is no second reader of one process; two processes resuming one id
   at once is unverified.
5. **Is there a recognizable last frame on process death, and what does the
   log say about an in flight tool call?** No runtime frame. The last record
   is OAR's `exited` response with `requestId ""` and code `null` (source,
   death test). The stream then holds a `tool_call_started` with no
   `tool_call_ended`. The transcript then holds the `tool_use` without its
   `tool_result` until a `--resume` writes an interrupted error result and a
   synthetic `No response requested.`
   ([crash and resume](crash-resume.md), 2.1.284).
6. **Do hosted forms report environment lifecycle events?** Not on OAR's
   path. The CLI exposes background, cloud, teleport, and remote control
   modes (vendor); OAR spawns none of them and has no evidence about their
   events or granularity. The local surfaces probed on 2.1.237/2.1.261 do
   not appear to have an environment lifecycle concept.

### Tool call outcome reporting

A `tool_result` block reports its call's outcome through `is_error` ([src]
stream-json schema). Vendor: the Messages API defines the field as optional,
false by default ([tool result blocks][native-tool-result]). Observed: the
inspected transcript (2.1.237) has 2217 `false` and 158 `true`; 2.1.288 leaves
the field out of a successful Read, Write or Edit result and keeps `false` on
Bash (Ferry's log, 2026-10-03), so an absent field reads as `ok`. The
[tool round fixture](../../tests/replay/fixtures/claude-tool-round.raw.jsonl)
has no `is_error` on its result: the
[recording helper](../../sea-trial/record/claude.ts) keeps only
`tool_use_id` and `content`. The mapping to `tool_call_ended.result` is in
the [mapping table](#high-level-mapping-to-oar); the block stays verbatim in
`native`. A missing tool result after process death is not an observed
failure.

### Native identity, the peer registry, and declared capability, probed live

Observations from **2.1.237** and **2.1.261** on linux x64, probed 2026-09-12
outside OAR. They describe the runtime's own local surfaces, not adapter
behaviour.

**Identity is the live process, not the connection.** Session identity is a
UUID that names the session JSONL file; the runtime process mints and
registers it locally, with no central authority. Runtime identity is
separate: a triple `(pidDomain, pid, procStart)` plus one socket per process
at `cc-socks/<pid>.sock`. The socket path is the address, so a process, not a
connection, is addressable. `pidDomain` carries a PID-namespace inode, which
keeps two containers from colliding, and `procStart` guards against PID
reuse, so the triple is host local while the session UUID is globally unique.
The two layers have different lifetimes.

**Discovery is peer to peer; stale registry entries were observed.** There is
no broker: an observer reads `~/.claude/sessions/` and connects to the peer's
socket. `sessions/<pid>.json` was not removed after the observed process
deaths (PID 1360120's entry remained with no such process), and 52 empty
`session-env/<uuid>/` directories remained from processes long gone. A
registry entry alone does not establish liveness; a reader has to verify it
against the socket or `procStart`.

**`peerFeatures` reports declared capabilities.** A peer reads the feature
list the other side reports rather than assuming. The list grows with the
version: one entry on 2.1.237, three on 2.1.261, visible directly when both
versions run on one machine. The declarations were inspected; none of the
advertised features was exercised.

## Verification and open gaps

[`experiments/live-contract.ts claude`](../../experiments/live-contract.ts)
covers every promise above on the real login (logs under
`oar-trial-run/live-claude-*`); the remaining
[experiments](../../experiments/README.md) cover steering phases, abort,
queue, resume, catalog and model readback.
[Vendor tests](../../sea-trial/vendor/claude.vendor.test.ts) use the real CLI
with a scripted model for tools, 400-error settlement, silent 401 retry,
approval bypass, prompt configuration through compaction and the dispose
tail. Shared [session cases](../../sea-trial/cases/session.ts) intentionally
make weaker steering/resume assertions.

Open gaps: an effort clamp by `maxEffortLevel` or an override by
`CLAUDE_CODE_EFFORT_LEVEL` (the read-back refuses either; neither was
exercised), missing-ID resume behavior, accepted-input receipt under load,
late interrupts across turns, context fullness after multi-step work, child
usage attribution and concurrent-child interleaving, native identity changes
after conversation reset, the resumability floor of a session JSONL, and
whether anything ever collects `sessions/<pid>.json` or `session-env/<uuid>/`.

[native-cli]: https://code.claude.com/docs/en/cli-reference
[native-sessions]: https://code.claude.com/docs/en/agent-sdk/sessions
[native-loop]: https://code.claude.com/docs/en/agent-sdk/agent-loop
[native-input]: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
[native-output]: https://code.claude.com/docs/en/agent-sdk/streaming-output
[native-subagents]: https://code.claude.com/docs/en/agent-sdk/subagents
[native-permissions]: https://code.claude.com/docs/en/agent-sdk/permissions
[native-mcp]: https://code.claude.com/docs/en/agent-sdk/mcp
[native-tool-result]: https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use
