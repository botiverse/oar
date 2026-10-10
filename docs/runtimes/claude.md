# Claude Code

Mapping claims follow current OAR source. Observations name their binary: the
live contract ([`experiments/live-contract.ts claude`](../../experiments/live-contract.ts))
ran on **claude 2.1.268** (darwin arm64, haiku, 2026-09-11); the probes on
**2.1.237** and **2.1.261** (linux x64) are listed in the
[experiments index](../../experiments/README.md); later observations carry
their version inline. The October 7 daily check re-ran `basic`, `tool-detail` and
`resume` on **2.1.292** (2026-10-07,
[report](../../experiments/runtime-version-checks/2026-10-07.md)), along with
14 native vendor tests, including MCP attachment and resume. An evening
follow-up on **2.1.293** compared the Haiku alias, effort and steer requests
against 2.1.292 using a scripted provider
([probe](../../experiments/claude-293-compatibility.ts)); findings appear
below. Versions are evidence baselines, not a support range.
Tags follow the [spec conventions](../spec/README.md): `[src]` vendor source,
`[sym]` binary symbols, `[env]` observed. See the [runtime index](README.md)
for status labels.

The [October 9 daily check](../../experiments/runtime-version-checks/2026-10-09.md)
passed the same three live scenarios on **2.1.295** (Linux x64,
`claude-haiku-5-5`), after a native session-limit reset. All 36 native vendor
tests and 17 applicable shared behavior cases passed using a local provider.
The original limited attempt remains in the evidence; no adapter change was
needed.

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

Known credentials passed through `SessionOptions.env` are removed from OAR
records and errors even if a provider echoes them in a failure. See the
[shared credential rules](../spec/record-stream.md#the-rules) for the exact
name, length and path rules. A real CLI regression verifies a local
provider's echoed authentication header across live delivery and replay.

## High-level mapping to OAR

| Native concept or interface | OAR mapping (record stream) |
|---|---|
| CLI process | One owned subprocess per OAR Session; stdio carries inputs, controls, and frames. Its exit is an `exited` response record (answering `dispose` when OAR caused it). |
| Persistent session ID | `Session.id`, passed as `--session-id` or `--resume`. Every record carries it as `sessionId`. |
| stream-json frame | One `Frame` record per stdout line (control traffic below and the effort read-back at open are the exceptions): `type` = `type[/subtype]`, `native` = the frame verbatim, `events` = OAR's readings (text_delta, reasoning, tool_call_started/ended, user_message, turn_ended, usage, model, task_*, compaction_ended). Frames OAR does not interpret (`system/thinking_tokens`, …) carry no events; nor does `rate_limit_event`, read only for a failed turn's `resetsAt` ([below](#usage-limits)). No `spanId`: claude frames carry no turn id. |
| User turn and `result` | The `prompt` request records intent. After native `command_lifecycle queued`, its turn starts at the matching `started`; otherwise the request remains the fallback start. The root `result` frame ends it with a `turn_ended` event (`aborted` while OAR's own interrupt is outstanding, `failed` on `is_error`, else `completed`; a subscription limit's refusal is `quota` with that limit's `resetsAt`, [below](#usage-limits)) plus a `usage` event: the root's tokens from the main loop's `usage`, the session total from `modelUsage` ([tokens](#token-totals)). |
| Subagent messages (`parent_tool_use_id`) | `agentPath = [...parentPath, taskCallId]` ([details](#observation-children-and-history)); `capabilities.attribution` is `attributed`. |
| `tool_use` / `tool_result` blocks | A streamed `content_block_start` gives `tool_call_started` (`callId`, `tool`, no input); `input_json_delta.partial_json` gives append-only `tool_call_input_delta`; the completed `tool_use` gives `tool_call_input` with the whole input. Without a partial opening, the completed block gives one `tool_call_started` carrying its input. `tool_call_ended` (`callId`, `content`, `result`): `is_error: true` is `failed`; `false` or an absent field is `ok` ([evidence](#tool-call-outcome-reporting)). |
| `control_request` / `control_response` | OAR's interrupt is an `abort` request record whose id is the `control_request` id; claude's `control_response` becomes its `accepted`/`rejected` response. A `control_request` from claude is recorded as a Frame plus an unanswered `toApp` request: under `--dangerously-skip-permissions` no `can_use_tool` arrives, but an MCP server's `elicitation` does (2.1.292); `events()` reads it as `app_request` with the request subtype as `type`. A `control_cancel_request` (claude withdrawing a request it sent) reads as `app_request_cancelled`: on 2.1.292 an interrupt while an MCP server's `elicitation` waited was answered, then claude cancelled the elicitation under its `request_id`, then the turn's `result` followed. |
| `system/task_*` | `task_started`, `task_updated`, `task_ended` events for commands, subagents, workflow runs and backgrounded MCP calls (claude moves a main-conversation MCP call past two minutes to the background). A changed `task_progress.description` emits `task_updated`; repeated descriptions do not. `background_tasks_changed` and nested `workflow_progress` stay native. |
| `command_lifecycle` | For inputs OAR wrote as prompts (including an idle or drained `queue`), `queued` gives `input_queued { inputId }` and `started` gives `turn_active { inputId }`, using `command_uuid`. `cancelled` before that input has `started` gives `input_dropped { inputId, reason: "turn_interrupted" }`. A replayed user message or `completed` before this write has received either `queued` or `started` proves an ignored duplicate input id and gives `input_dropped` with `reason: "runtime_refused"`, `failure: "invalid_request"` and a diagnostic `message`. Other `completed` frames, steer lifecycle frames, and `cancelled` after `started` remain native-only. |
| `system/init` | The reported model and service tier; additionally `turn_active` without input identity when a root turn starts on its own, including while a host prompt is still natively queued. A repeated init in an active turn gives no second start. |
| `system/compact_boundary` | The after-the-fact compaction report: a `compaction_ended` event, outcome `completed`, `trigger` from `compact_metadata.trigger` (`manual` \| `auto`). The frame carries `compact_metadata { trigger, pre_tokens, post_tokens?, cumulative_dropped_tokens? }` [sym 2.1.272]. claude has no start frame, so no `compaction_started`, no `retry` (401s are retried silently) and no `tool_call_progress` (tool output arrives whole in the `user` tool_result frame). |
| SDK configuration and interaction APIs | `--model`, `--effort` (confirmed by `get_settings` at open), service tier ([below](#service-tiers)), the system prompt flags and `--mcp-config` ([session MCP servers](#session-mcp-servers)). |

Sources: [adapter](../../packages/oar/src/runtimes/claude/session.ts),
[projection](../../packages/oar/src/runtimes/claude/projection.ts),
[task frames](../../packages/oar/src/runtimes/claude/tasks.ts),
[Session contract](../../packages/oar/src/contracts/session.ts).

## Capability details

### Session creation and resume

OAR's resume call:

```sh
claude -p --input-format stream-json --output-format stream-json --verbose \
  --replay-user-messages --include-partial-messages \
  --dangerously-skip-permissions --resume SESSION_ID
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
sends the native `initialize` control request and waits for success within
the existing 30-second readback bound. A requested `serviceTier` uses that
same answer, and requested `effort` is read back afterward. Then a resume
asks `get_usage` for its [token baseline](#token-totals), within the same
bound; that answer never fails the open. Fresh opens without either setting
keep the immediate post-spawn path; no fresh open sends `get_usage`.

A missing resume ID reports `result/error_during_execution` before answering
`initialize`, then exits. When `errors[0]` starts exactly with
`No conversation found with session ID`, OAR rejects with
`SessionNotFoundError`, the requested `sessionId`, Claude's `errors` text and `cause: { method: "initialize", native: <result frame> }`, under the
shared credential-redaction rules. This narrowly pinned prose is a last resort;
other execution failures keep their original errors
([missing targets](../spec/runtime-matrix.md#missing-resume-targets)). An exit without a result names the exit
code; an unanswered handshake reaches the readback deadline. Both fail the
open and release the process. Observed on 2.1.292 and repeated on 2.1.295
(2026-10-09): the missing-ID result arrived at about 0.8 seconds, followed by
exit code 1 at about 1.2 seconds, with no initialization answer or model
request. [Recorded frame](../../tests/fixtures/claude-missing-resume.json),
[readback regressions](../../tests/claude/claude-resume.test.ts),
[real CLI and local-provider tests](../../sea-trial/vendor/claude-resume.vendor.test.ts).

The successful initialization response is not recorded because it carries
account details, including email, organization and subscription, plus a
process ID and a home-directory path; nor is the `get_usage` answer, which
carries the subscription type, rate-limit windows and credit amounts beside
the session totals. The private readback establishes
readiness, not proof of restored history; a prompt's outcome still
establishes continuity. The reopened adapter keeps the native session
id, but has fresh observers, sequence numbers and an empty queue. It takes
startup options again and restores neither old control handles nor historical
OAR records. [Adapter](../../packages/oar/src/runtimes/claude/session.ts),
[kernel](../../packages/oar/src/shared/session-kernel.ts).

Fork, session listing, history retrieval, rewind, and reset identity management
are **not exposed**. Duplicate transcripts and concurrent controllers resuming
one ID are **unverified**.

### Interrupted input

A plain interrupt preserves unread steering input. On 2.1.293, the
`control_response` receipt's `still_queued` listed its UUID and a later
provider request contained the input, so OAR does not emit `input_dropped`
from that interrupt or from its result. The installed binary documents
`cancel_queued: true` as a separate interrupt option, advertised by
`interrupt_cancel_queued_v1`. OAR sends it only when that capability has
been declared by `system/init` and OAR has written a prompt-like input that
has not received `command_lifecycle started` yet. This includes the short
window before `queued` arrives. All other aborts use an ordinary interrupt.
The bulk option also removes queued task notifications without UUIDs; those
notifications are not listed in the receipt. It does not clear OAR's held queue.

The native `command_lifecycle cancelled` returns the input via `input_dropped`
only if that prompt-like input has not received `started`. It clears the
pending input even without an OAR abort request. After `started`, an ordinary
abort also ends with `cancelled`, after the turn's result; this is not an input
discard and remains native-only. A matching input wait resolves as `aborted`
on the drop, without synthesizing `turn_ended`. The status becomes idle only
if no other native turn is running. An `awaitIdle` during that other turn
continues until it too ends.

Without the declared capability, the ordinary interrupt targets the running
turn; a pending prompt reported in `still_queued` may run afterward. No
cancellation is inferred from an absent echo or an empty `still_queued`.
[Earlier plain-interrupt probe](../../experiments/input-interruption-2026-10-08.md).
Four Claude 2.1.292 recordings with a scripted provider pin the distinction:
[collision](../../tests/replay/fixtures/claude-cancel-queued-collision.raw.jsonl),
[before start](../../tests/replay/fixtures/claude-cancel-queued-before-start.raw.jsonl),
[cancel-queued after start](../../tests/replay/fixtures/claude-cancel-queued-after-start.raw.jsonl),
and [ordinary interrupt after start](../../tests/replay/fixtures/claude-plain-interrupt-after-start.raw.jsonl).
The before-start case has no init or result at all. Adjacent `.stdin.jsonl`
files preserve each experiment's requests; the after-start experiment forced
`cancel_queued`, whereas OAR sends an ordinary interrupt once `started` is known.

### Prompt, steering, queueing, and abort

**Prompt (mapped):** `prompt(string)` records a `prompt` request and answers
it `accepted` once the user message is on stdin, or `rejected` `busy` while a
turn or a natively queued prompt is owned. A `system/init` before a queued
prompt has started is a separate spontaneous turn, with no prompt attached.
A basic turn's frames are `system/init`, several `system/thinking_tokens`, a
`rate_limit_event` (not on every turn), one `assistant` frame per content
block (thinking, then text) and `result/success`, plus the prompt's `user`
echo that `--replay-user-messages` adds; the number of frames varies from
turn to turn. The [multi-turn fixture](../../tests/replay/fixtures/claude-multi-turn.raw.jsonl)
holds two such turns, recorded without the echo.
[Projection](../../packages/oar/src/runtimes/claude/projection.ts).

**Native input/turn attribution:** OAR generates an `inputId` UUID when
omitted, and writes it as the user frame's `uuid`. Claude's `command_lifecycle queued`
establishes that this input has not started; the matching `started` begins
its turn, and the next root `result` ends it. A turn that ends between queued and started is a separate spontaneous turn.
Claude can also fold a queued input into an ongoing notification turn at a
tool boundary: its replayed user message precedes `started`, without a new
init. That input is delivered normally and shares the following result. `completed` is
not a turn boundary: it follows the prompt's result, but for a steer can
precede that result. Steer queued/started frames are not projected as turn
facts; its replayed user message already reports its landing. Both queue
write paths are registered as prompt-like inputs when actually written.
Without a matching queued report, the existing request/init/result behavior
remains. Queue evidence alone changes no visible phase or input placement:
the prompt remains `running/waiting_model`. A conflicting native turn moves
its input to pending and removes only its empty provisional segment. That
turn's result restores `waiting_model` for the pending prompt; its matching
start places the input before its own turn. `awaitIdle` waits through the
intervening result until the pending input completes or is cancelled.

`promptAndWait` sends a UUID by default (or the caller's `inputId`) and uses
these facts to return only that prompt's answer. `awaitTurnEnd(session, seq,
inputId)` and `turnEndAfter(records, seq, sessionId, inputId)` can use the same
correlation. Without `inputId`, those lower-level helpers still return the
first root end after the cursor. A process exit always releases the wait.
Direct `session.prompt()` callers can pass `result.request.body.inputId`
(with the prompt body narrowed) to those helpers, including generated IDs.

**Use a fresh inputId for every resend.** Claude remembers message UUIDs,
including cancelled queued inputs and messages in resumed sessions. Reusing
one can produce only a replayed user message and/or `completed`, without a
turn. For a registered prompt-like write with no `queued` or `started`
since that write, OAR reports `input_dropped` with `reason: "runtime_refused"`,
`failure: "invalid_request"` and `message: "claude ignored the input: its inputId was already used in this session"`.
This frees the prompt slot; input-scoped waits return that failed outcome
without waiting for a turn or killing the process. A replay after `queued`
or `started` is not a duplicate refusal. These facts reset on every write,
so reusing an id previously queued and cancelled is still detected.

[Recorded regressions](../../tests/claude/claude-duplicate-recordings.test.ts)
cover resend after cancellation, reuse after resume, and a queued prompt
folded into a notification turn. Each keeps the original stdin and stdout
sequence, with local paths removed.

Evidence: Claude 2.1.292 with a scripted provider, no account:
[notification collision](../../tests/replay/fixtures/claude-workflow-prompt-collision.raw.jsonl)
and its [two host writes](../../tests/replay/fixtures/claude-workflow-prompt-collision.stdin.jsonl),
plus the [mid-turn steer order](../../tests/replay/fixtures/claude-steer-lifecycle.raw.jsonl).
[Regressions](../../tests/claude/claude-command-lifecycle.test.ts) keep live
records, pure projection and replayed status/view in agreement.

**Steer (mapped, landing observed):** `steer()` writes stdin and records
`accepted`, which hands delivery to the adapter and does not prove model
receipt. In multi-step turns claude absorbs the input at the next model step:
a steer issued after the first `tool_call_started` of a two-tool turn landed
in the same turn's final text with one `turn_ended`. Input arriving after the
last step becomes a subsequent turn.

On 2.1.293, `haiku` selects Haiku 5.5. In the scripted two-step probe,
the mid-turn input reached the next Messages API request as a `role:
"system"` entry in `messages`, before the same turn ended. Haiku 4.5 on
2.1.292 and 2.1.293 carried it in a user entry. The replay echo and its UUID
were unchanged. aimock's normalized chat messages omit that system entry;
provider-inclusion tests inspect the original request body, separately from
the native acknowledgement.

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

With empty text and images, OAR sends only image blocks on stdin. Claude
2.1.293 still adds its own system reminder and image-source label to the
provider request; neither is an empty user-text block. Verified with the
[image-only provider test](../../sea-trial/vendor/image-only.vendor.test.ts), without a login.

**Queue (mapped):** `queue()` is adapter-held (`capabilities.queue.durable:
false`), drained one message per turn end; the queued input runs as a
spontaneous turn with no prompt request of its own. A queue while idle is
written at once. `withdraw(inputId)` takes a held message back before a turn
end writes it (`accepted`) and answers `not_queued` once it is on stdin;
this is independent of the native bulk cancellation used for a pending prompt
([input cancellation](input-cancellation.md),
[test](../../tests/claude/claude-session-withdraw.test.ts)).

**Abort (mapped):** `abort()` records an `abort` request whose id is the
`control_request` id and sends `control_request/interrupt`; claude's
`control_response` (`still_queued: []`) is that request's `accepted`
response, and the turn ends on claude's own `result/error_during_execution`,
which the fold classifies `aborted` because OAR's interrupt was outstanding.
A late abort is rejected `no active turn`.

If claude exits before replying and before OAR's fallback, each pending
interrupt is answered once with `rejected: runtime_exited`. If the turn is
still running ten seconds after the first abort, OAR accepts its pending
interrupts before terminating the process using the cleanup described below.
A late `control_response` remains a frame only. The timer follows the turn,
even after an interrupt acknowledgement, and is cleared when the turn ends
or a native drop leaves no turn or prompt pending;
a native refusal cancels only that attempt. The folds read exit after an
accepted abort as `aborted`, and an unrequested exit as `failed:
runtime_exited`. A native `result` arriving first keeps its own outcome.
Continue after forced termination by resuming the
session. [Exit and deadline tests](../../tests/claude/claude-session-death.test.ts),
[real-binary transport-fault test](../../sea-trial/vendor/abort-fallback.vendor.test.ts).

**Unreachable runtime:** a `dispose` mid-turn ends with `request dispose`,
`response exited` (code 143) and no `result` frame, so the turn end for
observers is the exit itself, read as `aborted` from the dispose request.
The exit code remains unchanged. When claude dies on its own (SIGKILL), the
stream gets `response exited` with `requestId ""` and code `null`; the kernel
then rejects every prompt/steer/queue/abort `runtime exited` and answers a
later `dispose` `accepted`
([test](../../tests/claude/claude-session-death.test.ts)).
[Phase probe](../../experiments/claude-stream-json-phases.ts),
[adapter probe](../../experiments/claude-session-adapter.ts),
[queue probe](../../experiments/session-queue.ts).

### Usage limits

A claude.ai subscription's limits (the five-hour session, the weekly ones,
paid overage) reach the stream as `rate_limit_event` frames,
`{type, rate_limit_info, uuid, session_id}`. `rate_limit_info` is
`{status: allowed | allowed_warning | rejected, resetsAt?, rateLimitType?,
utilization?, overageStatus?, overageResetsAt?, isUsingOverage?, …}`, with
`resetsAt` in unix seconds and `rateLimitType` one of `five_hour`,
`seven_day`, `seven_day_opus`, `seven_day_sonnet`,
`seven_day_overage_included`, `overage` ([src] Agent SDK 0.3.295
`SDKRateLimitInfo`, "emitted when rate limit info changes"; [sym] 2.1.289
`rate_limit_info` schema). claude reads the limits from the
`anthropic-ratelimit-unified-*` response headers, so API-key, Bedrock and
Vertex sessions get none. A refused request (a 429) updates the limits
before claude writes the turn's error `assistant` frame (`error:
"rate_limit"`, text such as "You've hit your session limit · resets 3pm")
and the `result` (`api_error_status: 429`), and a changed view is sent at
once ([sym] 2.1.289: the print-mode listener on the limits' change emits the
frame; an unchanged rejection is sent again at most every 30 s, behind a
flag that is on by default). claude also marks a subscriber's 429 that
carries no limit headers `rejected`, with no reset, and words it a
temporary capacity issue ([sym] 2.1.289).

**Mapped:** the frame carries no event. The projection keeps the latest
event's reset when it says `rejected`, overage does not take the requests
(`overageStatus` absent or `rejected`) and it names `resetsAt`, until
another event replaces it. A turn whose error category is `rate_limit`
then fails as `quota` with that `resetsAt` (status 429): a usage limit
until it resets, so `failureAdvice` says `later`. Without such an event (an
API key's throttling, a gateway, a rejection naming no reset) it stays
`rate_limited` with no `resetsAt`. The kept time is claude's last report
and may already be past when a later turn fails; oar reads no clock for
it, and a host treats a past time as unknown. The reset is never read from
the error text, from `get_usage`
([account usage](#process-ownership-environment-installation-and-account-usage))
or from `overageResetsAt`.

**Evidence: the SDK types and the binary only, no live run.** oar never
deliberately triggers an error on a real account, and a subscription's
limit is the only way to make claude send a `rejected` event; a scripted
provider cannot stand in, because claude reads these headers only on a
claude.ai login ([when a limit resets](../spec/runtime-matrix.md#when-a-limit-resets)).
[Failure](../../packages/oar/src/runtimes/claude/failure.ts),
[test](../../tests/claude/claude-limit-reset.test.ts).

### Observation, children, and history

**Mapped:** every JSON frame enters the stream verbatim in `native` (of a
Frame, or of the response record for a control reply), except the effort
read-back answer the adapter consumes at open, so message identity, input
echoes, control replies and telemetry are there even where OAR has no event
for them. OAR requests `--include-partial-messages` on both new sessions
and resumes. Every `stream_event` becomes a frame, including message/block
boundaries, signatures and partial tool JSON. Text and thinking deltas become
`text_delta` and readable `reasoning`, with the API `message.id` carried from
`message_start` as `messageId`. A completed `assistant` block only projects
text or reasoning that was not already streamed. Redacted and empty thinking
remain distinguishable. Final result usage is unchanged.

Claude 2.1.293 emits each completed block just before its
`content_block_stop`; several completed blocks can share one API message ID.
Deduplication tracks blocks independently within each agent's message, so
parallel child output does not suppress root output or another child. A
`message_stop` releases that agent's partial projection state; its raw
records remain available.

Tools start once, with their original IDs. A partial `content_block_start`
for `tool_use` gives `tool_call_started` without input. Each
`input_json_delta.partial_json` becomes `tool_call_input_delta {callId, delta}`,
using the block index within that agent's current API message to find the
call. OAR does not parse or accumulate these fragments in the adapter. The
completed `assistant.tool_use` emits `tool_call_input` with the complete
input, replacing the preview even if it differs from the fragments. Without
a partial opening, including children that only report completed blocks,
the original single `tool_call_started` carries the full input.

`SessionView` appends argument text and sets `inputPartial: true` after a
delta; the complete input clears it. Interrupted tools retain any partial
input, and later input can replace it without changing their ended state.
Hosts consuming events directly must allow the opening event to have no
input and use the complete input event before parsing arguments.

Evidence: the [Claude 2.1.292 recording](../../tests/replay/fixtures/claude-tool-input-stream.raw.jsonl)
from 2026-10-10 uses a mock provider and local MCP echo tool, with sanitized
paths and no account. A root tool's 20 KB input arrives in 313 fragments,
then the complete assistant block, then `content_block_stop`. The fragment
sizes reflect the mock provider's 64-character chunk setting, not a native
guarantee. A child in the same recording has only a completed block.
[Replay assertions](../../tests/claude/claude-tool-input-stream.test.ts)
pin both paths and preserve every raw frame;
[native regression](../../sea-trial/vendor/tool-input-stream.vendor.test.ts)
checks long, escaped Unicode input on new and resumed sessions.

This emits more, smaller records, comparable to Codex's streamed deltas;
hosts retaining records should budget for them. `events(observer,
{ coalesceText: true })` combines consecutive text and readable reasoning
without duplicating the completed block. It changes the consumer view only;
every raw frame stays available. [Native streaming][native-output],
[projection](../../packages/oar/src/runtimes/claude/content.ts),
[native regression](../../sea-trial/vendor/claude-partials.vendor.test.ts).

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
state). With 2.1.293, a background Task against the scripted provider
reported complete child thinking/text blocks after the root result, but no
child `stream_event` frames. The partial-output flag does not make that
native child path incremental; its completed blocks remain the source of
child events. There is no child control handle. A subagent's spend is in the session
total but has no `byAgent` entry of its own: it is `unattributed`
([tokens](#token-totals)). The interleaving of concurrent children is
**unverified**. [Native subagents][native-subagents].

`rawEvents(observer, cursor)` replays the retained records after `afterSeq`
for the lifetime of the adapter process (a mid-turn subscribe replays exactly
the retained records and continues live; a full replay equals `records()`);
it is not a history API across processes. The
[recording helper](../../sea-trial/record/claude.ts) scrubs frames for
projection tests; it is not a public raw/replay interface.

### Service tiers

Claude 2.1.293 has both required native seams: a per-process
`--settings '{"fastMode":true}'` flag and the pre-turn `initialize` control
response's `fast_mode_state`. `SessionOptions.serviceTier: "fast"` uses that
flag on new sessions and resumes; `default` explicitly sends false. This
changes no user settings file. Any other tier is refused before launch.
`list_models` supplies `supportsFastMode`; OAR lists `serviceTiers: ["fast"]`
only when it is true. `default` is an opt-out, never a menu entry.

Before returning the session, OAR requires `on` for fast or `off` for
default. `off`, `cooldown`, an absent report or a native rejection cannot
confirm requested fast, and opening fails with both the request and native
status/reason. The wait is bounded to 30 seconds and failure stops the child.
Native error answers to this `initialize` or the effort `get_settings`
call are retained as `{ method, native }` in the thrown error's `cause`,
with known session credentials redacted. Successful `initialize` and
`get_settings` answers are never attached, even on a readback mismatch:
they include private account details and merged settings. Spawn failures
retain their existing safe diagnostic fields without the original Node error
or its arguments.
`get_settings.effective.fastMode` is **not** sufficient: it is configuration
intent, and `applied` currently carries no fast-mode status. Sonnet with
fastMode true still reports off and is correctly refused before a model call.

OAR passes its `--settings '{"fastMode":…}'` before the host's `launchArgs`.
Another `--settings` in `launchArgs` can override that choice; if the applied
mode no longer matches the requested tier, readback rejects the open instead
of silently accepting the override.

The initialization response is not recorded because it carries account
details. Success confirms the requested tier at open, but produces no
`service_tier` event; `Session.serviceTier()` remains null until a turn
reports it through `system/init` or `result`. Those reports map `on` to
fast, `off` and temporary `cooldown` to default. Native reasons remain in
the frame. A provider can downgrade fast after opening, so this is
observable state rather than a promise about future capacity or billing.

Real-binary tests in a fresh Claude config directory confirmed Messages
`speed: "fast"`, its removal on a resume with default, and fast again on
another resume. No real model account was used. See the
[native regression](../../sea-trial/vendor/service-tier.vendor.test.ts) and
[dated evidence](../../experiments/service-tier-2026-10-08.md).

### Models, instructions, and context

**Mapped:** `--model` selects the initial model; `model()` folds the `model`
event OAR reads from each `system/init` frame, so it is `null` until the
first turn's init frame (`haiku` reads back as `claude-haiku-4-5-20251001`).
Opening with a model that does not exist succeeds; the first turn fails with
claude's "issue with the selected model" message (`error: model_not_found`,
`api_error_status: 404`), classified `model_unavailable`
([failure evidence](../spec/runtime-matrix.md#claude)). The token-free `list_models` control request preserves
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
default effort); a model without effort (Haiku 4.5) sends none; and a
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

The `haiku` alias changed in 2.1.293 from
`claude-haiku-4-5-20251001` to `claude-haiku-5-5`. The new model reports the
requested `low` in `get_settings` and sends `output_config.effort: "low"`
with adaptive thinking. Explicit Haiku 4.5 still reports null and sends no
effort on both binaries. The refusal test therefore selects that concrete
model rather than assuming a moving alias lacks effort. OAR's effort
validation follows the native read-back and requires no change.

Replace/append instructions map to `--system-prompt` and
`--append-system-prompt`; native harness metadata may remain alongside
replacement text. The vendor test checks that the configured instructions
survive manual `/compact`.
[Adapter](../../packages/oar/src/runtimes/claude/session.ts),
[vendor test](../../sea-trial/vendor/claude.vendor.test.ts).

Context reporting is **partial**. The `result` frame's `usage` event carries
input/cache counts as context fullness and the token totals below
(`Session.contextUsage()` and `usage()` fold these events): across three
one-word turns `usage().value.total.input` grew by about 22k per turn (cache
reads included) while `contextUsage().value.tokens` stayed near 22k. Official
documentation describes result usage as aggregate main-loop usage for the
user turn, so the context figure is **unverified as current fullness** across
multiple model steps. Native compaction still runs and is reported after the
fact (mapping table above).
[Usage calculation](../../packages/oar/src/runtimes/claude/context-usage.ts),
[native usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

`Session.contextBreakdown()` asks claude itself what fills the window: the
`get_context_usage` control request with `detail: "full"`, the data `/context`
draws. claude 2.1.292 answered without a model call, and mid-turn in 0.5 s
while a Bash tool ran; each read does send the provider a batch of
`/v1/messages/count_tokens` requests (16 with tool search off and 28 with it
on, for one MCP tool, one agent, one memory file and 14 skills; more with
more), so a host reads it when the user asks and does not poll. Its `categories` keep claude's names and order (System
prompt, System tools, System tools (deferred), MCP server instructions, MCP
tools, MCP tools (deferred), Memory files, Skills, Custom agents, Messages,
Autocompact buffer, Free space); its kinds `used`, `deferred`, `buffer` and
`free` become `used`, `deferred`, `reserved` and `free`, and any other kind
is kept as `unknown`. `tokens` is `totalTokens`, the sum of the `used`
categories; `contextWindow` is `maxTokens`, which every category but the
deferred ones sums to. Four lists itemize their category: `memoryFiles` by
path, `skills.skillFrontmatter` by name, `agents` by agent type, and
`mcpTools` by tool name under the MCP category the answer has. `isLoaded`
does not follow the category (with tool search off the only category is MCP
tools, yet every tool says `isLoaded: false`), so it splits the tools only
when both MCP categories are there. The answer is consumed before the
projection, so it enters no record; a refusal rejects with claude's words,
and from the start of a dispose, and after the exit, the answer is null.
[Reader](../../packages/oar/src/runtimes/claude/context-breakdown.ts),
[test](../../tests/claude/claude-context-breakdown.test.ts).

### Token totals

claude reports two figures on each `result` ([#282](https://github.com/botiverse/oar/issues/282)).
Its schema (2.1.289) calls `usage` "MAIN AGENT LOOP ONLY — excludes Task
subagent, sidechain, and auxiliary model calls, and is per-turn in
streaming-input sessions. Prefer modelUsage for token/cost accounting", and
`modelUsage` the per-model totals of "every model call made through the
query pipeline … main loop, Task subagents, sidechains, and internal calls
such as compaction and Workflow agents", cumulative across turns: each
result carries the running total. [sym]

**Mapped:**

- `usage().total` is the latest `modelUsage`, summed over models: `input`
  is `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`
  (`inputTokens` excludes the cache, like `input_tokens`), `output` is
  `outputTokens`, and the two cache counts are `cacheRead` and `cacheWrite`
  ([spec](../spec/attribution.md#cache-reads-and-writes)). It is read, never
  summed across results.
- The root agent's `byAgent` entry is the main loop: each result's `usage`
  added up, as before, its `input` `input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens` (recorded: 39009 = 4 + 29198 read + 9807
  written, [replay](../../tests/replay/fixtures/claude-background-tasks.projected.txt)).
- `unattributed` is the rest: the subagents', sidechains' and compaction's
  calls. A subagent gets no entry, because the stream does not say what it
  spent: only its first `assistant` frame carries `parent_tool_use_id`, and
  that frame's `message.usage` is the stream-start value (3 output tokens
  in the recording), not the request's final usage, which claude's schema
  says "arrive[s] on the result message". [env 2.1.292]
- A result with a zeroed `modelUsage` (claude's crash and startup-error
  results: `{}` on the missing-resume result) leaves the total where it
  was. A total lower than the last one is claude resetting its running total
  (its schema: "a mid-session /clear resets the running total"): what this
  Session counted before stays, and counting restarts from zero. [sym; not
  recorded]
- **Resume.** The resumed process's `modelUsage` continues the previous
  process's running total (and so does `total_cost_usd`): its first result
  already carries the earlier turns. Before the first turn the adapter
  sends `get_usage` (`skip_behaviors: true`); its `session.model_usage` is
  that running total (`{}` when nothing was saved), consumed privately
  ([above](#session-creation-and-resume)), and every later `modelUsage` is
  less it, model by model, so `usage()` counts from when this Session
  opened ([spec](../spec/attribution.md#usage-one-constraint)). Don't know,
  don't report: when `get_usage` times out, fails, or answers without
  `session`, the Session's `usage` events carry `context` only and
  `usage().total` stays null, never the session's lifetime figure.
  `get_session_cost` is not used: it answers only human-readable text.

Recorded on 2.1.292 (haiku, 2026-10-09; [frames](../../tests/replay/fixtures/claude-usage-subagent-compact.raw.jsonl),
[projection](../../tests/replay/fixtures/claude-usage-subagent-compact.projected.txt),
[regressions](../../tests/claude/claude-token-usage.test.ts)): a turn that
ran one Task subagent reported main-loop input 43876 / output 834 and
`modelUsage` 69147 / 1011, so 25271 / 177 unattributed; a plain turn grew
both by the same 22563 / 29; a manual `/compact` reported a zeroed `usage`
while `modelUsage` grew by 23987 / 1173. The
[resumed process](../../tests/replay/fixtures/claude-usage-resume.raw.jsonl)
reported `modelUsage` 137784 / 2249 for one turn whose main loop spent 22087
/ 36: the previous process's 115697 / 2213 plus that turn. With the
`get_usage` baseline, `usage().total` is 22087 / 36. The `get_usage` answer
in the regressions is shaped from the schema, its `model_usage` the previous
process's last `modelUsage`, which a live read found identical
([adapter regressions](../../tests/claude/claude-usage-baseline.test.ts),
[token usage](../../packages/oar/src/runtimes/claude/token-usage.ts)).

### Tools, permissions, and extensions

Native Claude supports tool selection, MCP, agents, skills, plugins,
permission modes, and SDK approval/hook callbacks. Apart from session MCP
servers (`--mcp-config`, [below](#session-mcp-servers)) these are **not
exposed** as OAR configuration or interaction APIs. Native configuration may
still affect execution, but OAR does not pass `--strict-mcp-config`,
`--tools`, `--agents`, or explicit setting-source controls. Startup always passes
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

### Session MCP servers

`SessionOptions.mcpServers` is claude's `--mcp-config <path>`
([handoff](../../packages/oar/src/runtimes/claude/mcp-config.ts)). Each entry
becomes one `mcpServers` member of that JSON document: stdio
`{type: "stdio", command, args, env}`, http `{type: "http", url, headers}`.
Measured on claude 2.1.292 against a scripted provider
([vendor test](../../sea-trial/vendor/mcp-servers.vendor.test.ts),
[recording](../../tests/replay/fixtures/claude-mcp-echo.raw.jsonl)):

- Both transports attach, `system/init` lists each as
  `{name, status: "connected", source: "dynamic"}`, and the model calls a
  server's tool as `mcp__<name>__<tool>` (a name like `my server.x`
  becomes `mcp__my_server_x__echo`); `--dangerously-skip-permissions`
  covers MCP tools too. The tool result reached the provider as the
  server wrote it, so the server ran with the entry's `env` (stdio) or
  `headers` (http).
- The user's own servers stay: no `--strict-mcp-config`. On a name clash
  the session's server replaces a user-scope one of the same name
  (`~/.claude.json`, here a `CLAUDE_CONFIG_DIR`) for that process: one
  `echo` is listed, `source: "dynamic"`, and the call reached the
  session's server; the user's other servers still load.
- A resume remembers none: resumed without the option, `system/init` lists
  no server. oar passes the same flag on `--resume`.
- A stdio server inherits claude's whole environment (`SessionOptions.env`
  included) with the entry's `env` on top.

The path is never inline JSON on argv, where `ps` would show the
credentials. It is `oar-claude-mcp-<host pid>-*/mcp.json` in the system
temporary directory, a fresh 0700 directory
([test](../../tests/claude/claude-session-mcp-servers.test.ts)):

- **POSIX: a FIFO, so the values never reach a disk.** It is mode 0600.
  oar opens its write end once claude has opened the read end, polling
  without blocking, writes the document, closes, and removes the directory
  at once. Measured on 2.1.292: claude opens the path once, about 0.3 to
  1.3 s after it starts and before any prompt, and waits for the writer
  when it gets there first (a writer opened only once claude waited, and
  writing a second later, delivered the whole document). It keeps the
  config in memory: a stdio server it restarts and an http server it
  initializes again after a 404 both got their credentials with the path
  gone. A [vendor test](../../sea-trial/vendor/claude-mcp-config.vendor.test.ts)
  checks all three on every claude CI installs.
- **Windows, or no `mkfifo` to run: a 0600 file**, removed when claude
  exits however it ends (dispose, a crash, a refused effort).
- **A host that ends without disposing.** On its `exit` event
  (`process.exit()`, an uncaught exception) oar removes what is left. A
  signal or SIGKILL fires none: a file stays until the next claude session
  on the machine starts, which removes the directories of hosts no longer
  running ([test](../../tests/private-temp.test.ts)). A FIFO holds nothing,
  so nothing is on disk, but a host killed in claude's startup window
  leaves that claude waiting on the FIFO. The next claude session started
  with or without servers releases it: it reads an empty document, reports
  `MCP config is not a valid JSON` and exits
  ([test](../../tests/claude/claude-mcp-config-host-death.test.ts)).

claude's frames name servers and their status only, never an `env` or
`headers` value; the vendor test asserts no record holds one. A clash with a
project-scope (`.mcp.json`) or local-scope server was not measured.

### Workflows

Claude's local `Workflow` tool is available in headless stream-json sessions
[static binary inspection, 2.1.292]. It is disabled by
`CLAUDE_CODE_DISABLE_WORKFLOWS`, the `disableWorkflows` setting, an organization
policy that refuses `allow_workflows`, or the server's `tengu_workflows_enabled`
flag. `CLAUDE_CODE_WORKFLOWS=0` also disables it. Unless explicitly set,
`enableWorkflows` defaults off for Pro subscriptions and on for Max, Team and
API-key sessions; `CLAUDE_CODE_WORKFLOWS=1` uses the server flag as the default.
OAR does not change these gates or orchestrate the workflow.

One run is one `taskType: "workflow"` task, mapped from `local_workflow`.
Agent-team `in_process_teammate` tasks map to `agent`. For every native task
type, a changed `task_progress.description` becomes a `task_updated`
description, giving the host the runtime's current activity line. The task's
identity is `task_id`; the frame's `run_id` and the tool result's workflow
`runId` (`wf_…`) are separate native identifiers.

The nested `workflow_progress` list has phase and agent summaries, including
child tool command text, but is outside Claude's SDK schema. It stays in the
native frame under the normal credential redaction rules. OAR creates no
phase events, child-agent frames or per-agent tasks from that summary. Claude
emits none of those child frames on stdout. In native withhold mode
(`withholdScriptFromSdkEvents`), `prompt` is empty, phase names are generic,
agent prompt previews are removed and errors are withheld.

Each workflow call's spend appears in the first `result.modelUsage` written
after that call finishes. That can be the current host turn's result if the
call finishes before it, or a later result. It contributes to the session
total and `unattributed`, without an invented agent attribution. Task-frame `usage.total_tokens` sums the agents'
latest calls, not all their calls, so it is not spend and is never projected
as tokens. Closing before a later result may leave that spend unreported.
On completion Claude starts a turn itself (`system/init`) to handle the
notification. OAR reports `turn_active` and becomes busy immediately, even
before any text arrives. `TaskStop` instead yields a `killed` patch and a
`stopped` notification, both mapped to stopped; the recorded stopped run had
no notification usage and no spontaneous turn. Host `stop_task` control is
not exposed by OAR.

Evidence: Claude 2.1.292, a temporary HOME and a scripted provider with a
synthetic API key, no account. Three original recordings pin
[two phases/two agents](../../tests/replay/fixtures/claude-workflow.raw.jsonl),
[a child Bash call](../../tests/replay/fixtures/claude-workflow-agent-tool.raw.jsonl)
and [a stopped run](../../tests/replay/fixtures/claude-workflow-stopped.raw.jsonl).
Their [adapter regressions](../../tests/claude/claude-workflows.test.ts) check
native order, descriptions, spend and spontaneous turns. Withhold mode and
host-initiated stops were not exercised.

### Idle compaction

By default OAR's print-mode sessions use Claude's `sdk-cli` entrypoint,
which does not enable its idle-compaction timer. Removing the inherited
entrypoint prevents a parent desktop/editor session from changing that
behavior. An explicitly supplied entrypoint can still enable the native
path; OAR does not override that choice.

Static inspection of Claude 2.1.292 found these gates: `idleCompaction` may
disable it (true cannot force it), the server's `tengu_sunny_locket` must
select `mode: "compact"`, auto-compaction must be enabled, the cache duration
must be one hour, context must meet `minTokens` (default 200,000), quota must
be allowed, and no turn may be active. The default `fireAtFraction` is 0.9,
about 54 minutes. The session kind must not be bg/daemon, and the UI must be
interactive or the entrypoint must be one of Claude's supported desktop,
editor, remote, Slack, Teams or coworker entrypoints.

The native report is `compact_boundary` with `trigger: "auto"`; the schema
only distinguishes manual and auto, so OAR cannot distinguish idle from
threshold compaction. A `compaction_ended` while idle leaves `statusOf` idle,
including its last turn outcome. Only a running status moves to
`waiting_model`. The live idle trigger, any transcript notice and an
out-of-turn `system/status` were not exercised; the regression covers the
observed boundary schema outside a turn.

### Process ownership, environment, installation, and account usage

A synchronous host `exit` also kills OAR-owned process groups, including
live sessions and probes, and the descendants of each that left its group.
See [host lifetime and signal limits](../spec/record-stream.md#the-rules).

**Mapped:** OAR owns the spawned process; disposal settles active work, kills
the process, and waits for exit. On POSIX the process leads its own process
group: SIGTERM goes to the group, then SIGKILL if claude is still running
after a grace period (10 s, or `OAR_KILL_GRACE_MS`), so disposal settles even
when claude ignores SIGTERM
([process mechanics](../../packages/oar/src/shared/executable/process.ts),
[test](../../tests/session-dispose.test.ts)). The group does not hold all
claude starts: claude 2.1.292 runs each Bash tool command in a session of
its own (observed), which a group signal misses and which, once claude is
gone, is re-parented to init or a subreaper. So OAR also reads claude's
descendants from the process table (`/proc` on Linux, `ps` elsewhere) when
the kill begins and again just before the SIGKILL, and SIGKILLs those still
running, with the process groups they belong to, at the SIGKILL or as soon
as claude has exited, whichever comes first. A pid is signalled only while
its start time matches the one read, so a reused pid is spared
([process tree](../../packages/oar/src/shared/executable/process-tree.ts),
[test](../../tests/process.test.ts)). On SIGTERM, claude 2.1.292 ends its
running Bash commands and background tasks itself before it exits; the
descendant kill is what ends them when claude cannot (stuck, or stopped) and
only the SIGKILL ends it, as in the abort fallback that left a command
running in [oar#210](https://github.com/botiverse/oar/issues/210)
([vendor test](../../sea-trial/vendor/stuck-runtime-tools.vendor.test.ts)).
Only an end OAR starts (disposal, the abort fallback, host exit) does this:
when claude exits by itself, what it left running is not touched. Not
reached either: a process that had already left claude's tree when the kill
began (re-parented, e.g. a `nohup … &` whose shell has exited), and one
started after the first read that outlives claude's own exit.

The grace period's default is sized to claude's own SIGTERM handling
[sym 2.1.283]: it runs its SessionEnd hooks (a 1.5 s budget unless a hook
declares a longer `timeout`, capped at 60 s) and
force-exits after max(5 s, hook budget + 5 s), at least 15 s while writes are
still pending; the claude-aimock runs exited 0.6 to 2.3 s after the SIGTERM.
A longer hook budget needs a longer `OAR_KILL_GRACE_MS`, or the SIGKILL cuts
the hooks short. The own process group also takes claude out of the
terminal's job control: a host's Ctrl-C does not reach it, so a host that
wants it stopped disposes the session. This supplies resource release, not
detached execution or a lease against other controllers. The environment
overlay applies to the child process; `null` deletes an inherited variable
and `CLAUDECODE` is always removed. A host started from inside Claude Code
(its Bash tool or a hook) inherits that session's markers, and OAR removes
them from sessions and from the claude subcommands it runs (auth status, login,
logout, account usage, model list, inventory, `claude update`):
`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_CHROME_MCP_ORG_DENIED`,
`CLAUDE_CODE_EVAL_INTERVIEW_SESSION`, `CLAUDE_CODE_BRIDGE_SESSION_ID`,
`CLAUDE_CODE_HOST_WORKTREE`, `CLAUDE_CODE_HOST_WORKTREE_FENCE`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET` and
`CLAUDE_CODE_MESSAGING_TOKEN`. That is the list claude itself drops when it
launches an independent claude (2.1.292), plus the parent's messaging socket
and token. Left in, `CLAUDE_CODE_CHILD_SESSION` makes claude treat itself as
part of the parent session (skill proposals off, org memory refused, no prompt
history), and an inherited entrypoint replaces print mode's own `sdk-cli`.
`TRACEPARENT` and an `AI_AGENT` set by another tool pass through. An explicit
`SessionOptions.env` value for any of them still wins, except `CLAUDECODE`.
The installation probe (`claude --version`) and the vendor install script run
through the shared paths with the host environment.
[Markers](../../packages/oar/src/runtimes/claude/environment.ts). See the
[environment contract](../spec/runtime-matrix.md#session-environment). [Launch](../../packages/oar/src/runtimes/claude/launch.ts).

On Windows, disposal and the abort fallback use `taskkill /T /F` to terminate
the entire process tree, including a `.cmd` launcher and native claude. There
is no POSIX-style graceful signal phase; if the tree walk fails, OAR falls
back to terminating the direct child. Killing only the launcher left a live
provider request and further Claude output after the recorded exit in the
[native abort regression](../../sea-trial/vendor/abort-fallback.vendor.test.ts)
(Claude 2.1.292). The host-exit hook runs the same tree cleanup synchronously;
see the [lifetime limits](../spec/record-stream.md#the-rules).

Installation checks `OAR_CLAUDE_BIN`, PATH, then the native installer's
launcher `~/.local/bin/claude` (`%USERPROFILE%\.local\bin\claude.exe` on
Windows), which a GUI or service process's PATH can miss. When none is
found, `install` runs Anthropic's native installer,
`curl -fsSL https://claude.ai/install.sh | bash`
([setup docs](https://code.claude.com/docs/en/setup); macOS and Linux;
[runtime install](../spec/install.md), [sandbox run](install.md)). That
method because its copy is the native install `claude update` updates:
claude records `installMethod: native`, and `checkUpdate` reads the release
pointer for it. Update checks and upgrades are covered in
[runtime updaters](update.md). Account usage is separate from
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
[updater](../../packages/oar/src/runtimes/claude/update.ts),
[installer](../../packages/oar/src/runtimes/claude/install.ts).

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

### Logout

**Mapped** ([runtime logout](../spec/login.md#logout)): `logout` runs
`claude auth logout` over pipes with its stdin closed and `CLAUDECODE`
cleared, and `claude auth status --json` decides. Native behavior [bundle
2.1.292: `authLogout`, then `performLogout`]: claude first revokes the stored
claude.ai OAuth refresh token on Anthropic's side (`POST <token URL>/revoke`,
5 s); a revoke that fails is only logged and the local logout goes on, so
the token can then stay valid on the server until it expires. It then
deletes its stored credentials (`~/.claude/.credentials.json`, or the macOS
Keychain) and the account in `~/.claude.json`, and prints `Successfully
logged out from your Anthropic account.` with exit 0. A failure is `Logout
failed: <message>` on stderr with exit 1, which is `rejected` with the
message. Observed in a temporary home with no network [run 2.1.292]: logged
out already, claude prints the same success line and exits 0, and the result
is `logged_out`. With `ANTHROPIC_API_KEY` in its environment the status reads
`loggedIn: true`, `authMethod: "api_key"`, `apiKeySource:
"ANTHROPIC_API_KEY"` before and after the logout, so the result is `failed` /
`still_logged_in` (`claude auth logout succeeded, yet claude auth status
--json still reads logged in (api_key, from ANTHROPIC_API_KEY)`);
`CLAUDE_CODE_OAUTH_TOKEN` reads `oauth_token` the same way. OAR never touches
either variable. The deadline is 60 s. `auth logout` arrived in 2.1.41 with
`auth login` and `auth status` [doc changelog], so an older claude is
`unsupported` / `version_unsupported`. Verified against the fake CLI
([tests](../../tests/login/claude-logout.test.ts)); the real-login checklist
of [#192](https://github.com/botiverse/oar/issues/192) is not run yet.
[Logout](../../packages/oar/src/runtimes/claude/logout.ts).

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
| Vendor claim versus evidence | Confirmed by observation: resume continuity on the same `cwd` and in another one (2.1.288), interrupt through the control channel, subagent attribution through `parent_tool_use_id`. Vendor only: print mode transcript persistence identical to interactive mode. Unverified either way: two controllers resuming one id at once. Missing-ID resume fails before initialize succeeds (2.1.295). Vendor quirk observed: `result` frames with subtype `success` and `is_error: true`. | this page, [open gaps](#verification-and-open-gaps) |

### Eight dimensions

1. **Entry.** `claude -p --input-format stream-json --output-format stream-json
   --verbose --replay-user-messages --dangerously-skip-permissions` plus
   `--session-id <uuid>` or `--resume <id>`, and optional `--model`,
   `--effort` (then a `get_settings` control request before the first turn),
   `--system-prompt`, `--append-system-prompt`, `--mcp-config <file>` (for
   `SessionOptions.mcpServers`). `CLAUDECODE` is cleared from
   the child environment, as is an inherited `CLAUDE_CODE_ENTRYPOINT` (an explicit
   host entrypoint wins). Prompts are `user` message lines on stdin. Present
   in 2.1.261 help but not on the session path:
   `--fork-session`, `--no-session-persistence` (the inventory and account
   usage readers pass it), `--permission-mode`, `--permission-prompts`,
   `--strict-mcp-config`, `--tools`, `--agents`, `--bg`, `--cloud`, `--teleport`,
   `--remote-control`. Source:
   [launch](../../packages/oar/src/runtimes/claude/launch.ts).
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
   `toApp` request nobody answers. Under skip permissions no `can_use_tool`
   has been observed; an MCP server's `elicitation` has (2.1.292), and claude
   cancels it on an interrupt. Source: projection.
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

Open gaps: session MCP servers on a real login (verified against a scripted
provider only) and against a project- or local-scope server, an effort
clamp by `maxEffortLevel` or an override by
`CLAUDE_CODE_EFFORT_LEVEL` (the read-back refuses either; neither was
exercised), accepted-input receipt under load,
late interrupts across turns, context fullness after multi-step work, a
recorded `/clear` and `get_usage` answer, concurrent-child interleaving, native identity changes
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

## Disallowed tools

`SessionOptions.disallowedTools` goes to native `--disallowed-tools` on
both new and resumed print-mode processes. Use Claude names such as `Bash`,
`Read` and `mcp__server__tool`; OAR passes the names unchanged. Omitted or
empty lists add no flag. The native tool selector removes built-in and MCP
tools from provider requests even with OAR's usual permission bypass.

Unknown or wrong-case names such as `NoSuchTool` or `bash` are accepted
silently and disable nothing. Neither Claude nor OAR reports that no tool
matched; use the native spelling (`Bash`, not `bash`).

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).

## Launch arguments

`SessionOptions.launchArgs` go on claude's command line after OAR's own flags and before `--mcp-config` and `--disallowed-tools`. Both take several values until the next argument that starts with `-`, so a bare host value (one that is neither a flag nor a flag's value) after them would be read as theirs. OAR passes them unchecked: a flag that changes the stream-json protocol (`--output-format`, `--input-format`) breaks the session, and an unknown flag makes claude exit at once, so a fresh session without a readback can open with the exit as its first record; resume and settings readbacks reject at open if it exits before answering. Never recorded; give them again on resume. See [launch arguments](../spec/runtime-matrix.md#launch-arguments).
