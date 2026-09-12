# Claude Code

Evidence baseline: OAR source as of 2026-09-11; official documentation is
rolling. Live observations below come from **claude 2.1.268** (darwin arm64,
haiku) through [`experiments/live-contract.ts claude`](../../experiments/live-contract.ts)
and the probes on **2.1.237**/**2.1.261** (linux x64) listed in the
[experiments index](../../experiments/README.md). Versions are evidence
baselines, not a support range. See the [runtime index](README.md) for
evidence and status conventions.

## Native concepts and calling interfaces

Claude Code owns the agent loop, tools, context management, and persistent
conversation. A **session** is persistent conversation identity; a **user turn**
can contain multiple **model steps** and tool executions. Assistant messages
carry text, thinking, and tool-use blocks; tool results return in user-message
blocks. A result ends a user turn, not the lifetime of its conversation or
necessarily every native child. [Agent loop][native-loop],
[streaming input][native-input].

Native **subagents** have separate conversations and can run concurrently.
`Agent` tool invocation and `parent_tool_use_id` identify child activity; a child
identity, tool-call identity, and main session identity are different concepts.
[Subagents][native-subagents].

Programs have two relevant entry points:

- **CLI print mode:** `claude -p` supports structured output and bidirectional
  `stream-json`. A long-lived process can accept multiple user turns. This is
  the interface selected by OAR. [CLI reference][native-cli].
- **Claude Agent SDK:** TypeScript `query()` exposes an async message stream;
  native SDK APIs additionally provide configuration, callbacks, session
  discovery, history retrieval, and fork operations. OAR does not use this SDK.
  [SDK sessions][native-sessions], [permissions][native-permissions].

## High-level mapping to OAR

| Native concept or interface | Current OAR mapping (record stream) |
|---|---|
| CLI process | One owned subprocess per OAR Session; stdio carries inputs, controls, and frames. The exit is an `exited` response record (answering `dispose` when OAR caused it). |
| Persistent session ID | `Session.id`; supplied through `--session-id` or `--resume`. Every record carries it as `sessionId`. |
| stream-json frame | Exactly one `event` record per stdout line: `type` = `type[/subtype]`, `native` = the frame verbatim, `views` = OAR's readings (text_delta, reasoning, tool_call_started/ended, turn_ended, usage, model). Frames OAR does not interpret (`rate_limit_event`, `system/thinking_tokens`, …) are recorded with no views. No `spanId`: claude frames carry no turn id. |
| User turn and `result` | The turn's start is the `prompt` request record; the `result` frame is the turn's end, projected as a `turn_ended` view (aborted when OAR's own interrupt was outstanding, failed on `is_error`, else completed) plus a `usage` view. |
| Subagent messages (`parent_tool_use_id`) | `agentPath = [...parentPath, taskCallId]`: a frame attributes to the Task tool_use that spawned it, nested through that call's own agent. `capabilities.attribution` is `attributed`. Child usage is not attributed (unverified). |
| `control_request` / `control_response` | OAR's interrupt is an `abort` request record whose id is the `control_request` id; claude's `control_response` becomes its `accepted`/`rejected` response. A `control_request` FROM claude is recorded as a `toApp` request (unanswered; none arrive under `--dangerously-skip-permissions`). |
| SDK configuration and interaction APIs | Only a small subset is represented by OAR startup options and control methods. |

Sources: [adapter](../../packages/oar/src/runtimes/claude/session.ts),
[projection](../../packages/oar/src/runtimes/claude/projection.ts),
[Session contract](../../packages/oar/src/contracts/session.ts).

## Capability details

### Session creation and resume

The selected native resume call is:

```sh
claude -p --input-format stream-json --output-format stream-json --verbose \
  --dangerously-skip-permissions --resume SESSION_ID
```

OAR then writes newline-delimited frames such as
`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Continue"}]}}`.
New sessions replace `--resume` with `--session-id UUID`. The richer SDK equivalent
starts with `query({ prompt: "Continue", options: { resume: sessionId } })`;
`forkSession` instead creates a new identity from existing history.
[CLI reference][native-cli], [SDK sessions][native-sessions].

The resume token is a **native session ID**, not a turn ID or file path. Its
transcript must exist under the active Claude configuration home. Current native
documentation describes cross-directory ID lookup since 2.1.223; OAR's recorded
continuity probe uses the same cwd, leaving cross-directory behavior through OAR
**unverified**. Resume restores context for new requests, not a prior process.
[SDK sessions][native-sessions].

**Mapped:** `await claudeSession(installation, { cwd, resume: sessionId })` resolves
once the process is spawned, **before a native resume acknowledgment**; the
resumed stream starts empty (claude says nothing until the first turn). A
resumed session keeps the id and recalls the earlier transcript (same cwd).
Submit a prompt and inspect its outcome; startup alone does not establish
successful history restoration. The reopened adapter has fresh observers, turn IDs,
sequence numbers, and an empty queue. It supplies startup options again and does
not restore old control handles or historical OAR events.
[Adapter](../../packages/oar/src/runtimes/claude/session.ts),
[kernel](../../packages/oar/src/shared/session-kernel.ts).

Fork, session listing, history retrieval, rewind, and reset identity management
are **not exposed**. Missing-ID error timing, duplicate transcripts, and concurrent
controllers resuming one ID remain **unverified**.

### Prompt, steering, queueing, and abort

**Mapped:** `prompt(string)` records a `prompt` request and answers it
`accepted` once the user message is on stdin, or `rejected` `busy` while a
turn is active. A `system/init` arriving while nothing is active is a
spontaneous turn (a drained queue message): it has events but no request of
its own. The `result` frame ends the turn (`turn_ended` view); a basic turn
is nine records (`system/init`, `system/thinking_tokens`,
`rate_limit_event`, `assistant`, `result/success` plus the control pairs).
[Projection](../../packages/oar/src/runtimes/claude/projection.ts).

**Steer (mapped, landing observed):** `steer()` writes stdin and records
`accepted`; that transfers delivery responsibility to the adapter and does
not prove model receipt. In multi-step turns the input is absorbed at the
next model step: a steer issued after the first `tool_call_started` of a
two-tool turn landed in the same turn's final text with one `turn_ended`.
Input arriving after the last step becomes a subsequent turn.

**Queue (mapped):** `queue()` is adapter-held (`capabilities.queue.durable:
false`), drained one message per turn end; the queued input runs as a
spontaneous turn with no prompt request of its own.

**Abort (mapped):** `abort()` records an `abort` request whose id is the
`control_request` id and sends `control_request/interrupt`; claude's
`control_response` (`still_queued: []`) is that request's `accepted`
response, and the turn ends on claude's own `result/error_during_execution`,
which the fold classifies `aborted` because OAR's interrupt was outstanding.
A late abort is rejected `no active turn`.

**Unreachable runtime:** a `dispose` mid-turn ends with `request dispose`,
`response exited` (code 143) and no `result` frame, so the turn end for
observers is the exit itself. When claude dies on its own (SIGKILL), the
stream gets `response exited` with `requestId ""` and code `null`; every
later prompt/steer/queue/abort is rejected `runtime exited` by the kernel and
a later `dispose` is answered `accepted`
([test](../../tests/claude/claude-session-death.test.ts)).
[Phase probe](../../experiments/claude-stream-json-phases.ts),
[adapter probe](../../experiments/claude-session-adapter.ts),
[queue probe](../../experiments/session-queue.ts).

### Observation, children, and history

**Mapped:** every frame is an event record with the frame verbatim in
`native`; text blocks become `text_delta` views, reasoning retains text,
redacted, and empty distinctions, tools retain IDs and available
input/output. One assistant message with several blocks is one record
with several views in block order. Message identity, input echoes,
control replies and telemetry are therefore in the stream (in `native`),
even where OAR has no view for them. OAR does not request
`--include-partial-messages`, so `text_delta` does not imply token-level
streaming. [Native streaming][native-output],
[projection](../../packages/oar/src/runtimes/claude/projection.ts).

**Attributed:** frames carrying `parent_tool_use_id` get
`agentPath = [...parentPath, taskCallId]`, where `parentPath` is the agent
that issued that Task call: nested sub-agents nest the path. A Task
sub-agent's `user` and `assistant` frames arrive with that path; the root
additionally emits `system/task_started`, `task_progress`, `task_updated`
and `task_notification` frames (no views). Child records arriving after the
parent's `result` still enter the stream (nothing is gated on turn state).
There is no child control handle. No child `result` frame has been
observed, so child usage stays unattributed and `usage()` is root-only;
whether a child ever reports usage, and the exact interleaving of
concurrent children, remain **unverified**. [Native subagents][native-subagents].

`subscribe(observer, cursor)` replays the retained records after `afterSeq`
for the lifetime of the adapter process (a mid-turn subscribe replays
exactly the retained records and continues live; a full replay equals
`records()`); it is not a history API across processes. The
[recording helper](../../sea-trial/record/claude.ts) scrubs frames for
projection tests; it is not a public raw/replay interface.

### Models, instructions, and context

**Mapped:** `--model` selects the initial model; `model()` folds the `model`
view OAR reads from each `system/init` frame, so it is `null` until the
first turn's init frame (`haiku` reads back as `claude-haiku-4-5-20251001`).
Opening with a model that does not exist succeeds; the first turn fails with
claude's "issue with the selected model" message, classified
`invalid_request`. The token-free `list_models` control request
preserves selector versus resolved ID, disabled entries, and effort choices.
Live model/effort setters are **not exposed**.
[Catalog](../../packages/oar/src/runtimes/claude/list-models.ts),
[readback probe](../../experiments/session-model-readback.ts).

Replace/append instructions map to native system-prompt flags; native harness
metadata may remain alongside replacement text. The existing vendor test checks
that the configured instructions survive manual `/compact`.
[Adapter](../../packages/oar/src/runtimes/claude/session.ts),
[vendor test](../../sea-trial/vendor/claude.vendor.test.ts).

Context reporting is **partial**. The `result` frame's `usage` view carries
input/cache counts as context fullness and the running per-agent token total
(`Session.contextUsage()` and `usage()` are folds over these views): across
three one-word turns `usage().total.input` grew by about 22k per turn
(cache reads included) while `contextUsage().tokens` stayed near 22k. Official
documentation describes result usage as aggregate main-loop usage for the
user turn, so the context figure is **unverified as current fullness**
across multiple model steps. Native compaction still runs; its frames are in
the stream verbatim but OAR has no view for them.
[Usage calculation](../../packages/oar/src/runtimes/claude/context-usage.ts),
[native usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

### Tools, permissions, and extensions

Native Claude supports tool selection, MCP, agents, skills, plugins, permission
modes, and SDK approval/hook callbacks. These are **not exposed** as corresponding
OAR configuration or interaction APIs. Native configuration may still affect
execution, but OAR does not pass `--mcp-config`, `--tools`, `--agents`, or explicit
setting-source controls. Startup always passes `--dangerously-skip-permissions`;
there is no OAR approval request/reply channel.
[Native MCP][native-mcp], [permissions][native-permissions],
[adapter](../../packages/oar/src/runtimes/claude/session.ts).

### Process ownership, environment, installation, and account usage

**Mapped:** OAR owns the spawned process; disposal settles active work, kills the
process, and waits for exit. This supplies resource release, not detached
execution or a lease against other controllers. The environment overlay applies
to the child process; `CLAUDECODE` is cleared before applying that overlay.
[Adapter](../../packages/oar/src/runtimes/claude/session.ts).

Installation checks `OAR_CLAUDE_BIN`/PATH. Account usage is separate from session
context: the reader uses auth status and persisted profile-scoped OAuth
credentials for subscription windows. Inference credentials alone do not imply
account-usage access. Login management is **not exposed**.
[Installation](../../packages/oar/src/runtimes/claude/installation.ts),
[account usage](../../packages/oar/src/runtimes/claude/account-usage.ts).

## Harness fact matrix

This section answers the harness investigation questions for the one
interface OAR calls: print mode with bidirectional `stream-json`. Claude Code
ships as a closed binary, so there is no source to cite. Every row labels its
evidence: **source** is OAR adapter, projection, or test code at this
revision; **observed** is a recorded run or a file inspected on a named
binary version; **vendor** is native documentation that no observation here
has confirmed. Baselines: claude 2.1.268 (live contract, 2026-09-11), 2.1.261
(`claude --help` on linux, 2026-09-12), 2.1.237 (a native transcript file
inspected on linux, 2026-09-12).

### Matrix columns

| Column | Claude on OAR's path | Evidence |
|---|---|---|
| Session identity | A native UUID. OAR picks it (`randomUUID()`) for a new session and passes `--session-id`; a caller supplies it through `resume` and OAR passes `--resume`. Every record carries it as `sessionId`. It survives the OAR process: a later process resumes the same id and the model recalls the earlier transcript. | source [adapter](../../packages/oar/src/runtimes/claude/session.ts) lines 59 to 76; observed live contract resume scenario |
| Connection identity | None at the protocol level. One spawned process is the only connection; it has no id in any frame and there is no second client path. | source adapter; observed fixture frames carry `session_id` only |
| Transport cursor | None. Frames carry no sequence number and no turn id; `seq` is assigned by OAR's kernel and does not outlive the process. `--replay-user-messages` echoes user messages back and is not a position. | source [projection](../../packages/oar/src/runtimes/claude/projection.ts), [kernel](../../packages/oar/src/shared/session-kernel.ts) lines 168 to 183; vendor [CLI reference][native-cli] |
| Event stream scope | Per process. Frames go to the stdout of the process that produced them; nothing is broadcast to a second reader. | source adapter |
| Runtime side replay source | The native transcript, a JSONL file named `<sessionId>.jsonl` under the Claude config home in a per `cwd` directory. It holds message content, not OAR's stream: see question 2 below. `--resume` feeds that transcript back to the model as context; it does not replay frames to OAR. Diagnostic reference only: OAR's replay source is its own appended stream. | observed transcript 2.1.237; source [resume section](#session-creation-and-resume) |
| Vendor claim versus evidence | Confirmed by observation: resume continuity on the same `cwd`, interrupt through the control channel, subagent attribution through `parent_tool_use_id`. Vendor only: cross directory resume lookup since 2.1.223, print mode transcript persistence being identical to interactive mode. Unverified either way: two controllers resuming one id at once, missing id error timing. Vendor quirk observed: `result` frames with subtype `success` and `is_error: true`. | this page, [open gaps](#verification-and-open-gaps) |

### Eight dimensions

1. **Entry.** `claude -p --input-format stream-json --output-format stream-json
   --verbose --dangerously-skip-permissions` plus `--session-id <uuid>` or
   `--resume <id>`, and optional `--model`, `--system-prompt`,
   `--append-system-prompt`. `CLAUDECODE` is cleared from the child
   environment. Prompts are `user` message lines on stdin. Not on OAR's path
   although present in 2.1.261 help: `--include-partial-messages`,
   `--replay-user-messages`, `--fork-session`, `--no-session-persistence`,
   `--permission-mode`, `--permission-prompts`, `--mcp-config`, `--tools`,
   `--agents`, `--bg`, `--cloud`, `--teleport`, `--remote-control`. Source:
   [adapter](../../packages/oar/src/runtimes/claude/session.ts) lines 59 to
   76.
2. **Session and state storage.** Native identity and transcript are claude's;
   OAR's record stream is process memory behind `records()` and is gone with
   the process. OAR owns no storage. Source: kernel; observed: the transcript
   file described above.
3. **Event model.** Every stdout frame is one event record whose `type` is
   `type[/subtype]` and whose `native` is the frame verbatim. Frame classes in
   one recorded tool round: `system/init`, `system/thinking_tokens`,
   `rate_limit_event`, `assistant` with `thinking`, `tool_use`, `text` blocks,
   `user` with `tool_result` blocks, `result/success`. Plus
   `control_response` answering OAR's interrupt and `control_request` from
   claude. No deltas, because partial messages are not requested. A turn is
   the span from OAR's `prompt` request to the `result` frame; no frame names
   the turn. Source: [projection](../../packages/oar/src/runtimes/claude/projection.ts);
   observed: [tool round fixture](../../tests/replay/fixtures/claude-tool-round.raw.jsonl).
4. **Ownership and identity.** The spawning OAR process owns the child.
   Records carry `sessionId` and `agentPath`; `parent_tool_use_id` nests a
   child under the Task call that spawned it. There is no lease against
   another controller and no connection id. Source: adapter, projection.
5. **Capability honesty.** Declared `{ steer: true, queue: { durable: false },
   attribution: "attributed" }`. Steer accepted means written to stdin, not
   received by the model. Queue is adapter held. Source: adapter line 150;
   observed: [steering section](#prompt-steering-queueing-and-abort).
6. **Deployment and lifecycle.** Local subprocess only. Process exit is an
   `exited` response: answering `dispose` with code 143 when OAR caused it,
   with `requestId ""` and code `null` when claude died on its own. After
   that every control is rejected `runtime exited`. Hosted forms in the CLI
   (`--bg` with `attach`, `logs`, `respawn`, `rm`, `stop`; `--cloud`;
   `--teleport`; `--remote-control`) are vendor only here; OAR does not use
   them and has no evidence about their lifecycle events. Source:
   [death test](../../tests/claude/claude-session-death.test.ts); vendor
   [CLI reference][native-cli].
7. **Tools and permissions.** Always `--dangerously-skip-permissions`; no
   approval channel. `tool_use` blocks become `tool_call_started` with
   `callId`, `tool`, `input`; `tool_result` blocks in `user` frames become
   `tool_call_ended` with `callId` and `output`. A `control_request` from
   claude is recorded as an event and a `toApp` request that nobody answers;
   none has been observed under skip permissions. Source: projection.
8. **Extension points.** MCP, agents, skills, plugins, hooks, and permission
   callbacks exist natively; OAR passes none of them. On the control channel
   OAR uses `interrupt`; `list_models` is exercised only by an experiment.
   Source: [tools section](#tools-permissions-and-extensions);
   [experiments](../../experiments/README.md).

### Six questions

1. **Is the native session id stable across a host restart, and can it be
   reopened?** Yes for the id and for the same `cwd`: a new process with
   `--resume <id>` keeps the id and the model recalls earlier turns
   (observed, live contract). Reopening needs the transcript under the
   active config home; cross directory lookup is vendor only. What happens
   for a missing id, and how fast, is unverified.
2. **Does the runtime log keep every frame or only turn snapshots?** Neither.
   The transcript inspected here (2.1.237, an interactive session, 15869
   lines) is a tree of entries linked by `parentUuid`, one entry per
   `user`, `assistant`, `attachment`, or `system` item, plus bookkeeping
   entries such as `queue-operation`. It holds full content blocks, including
   `tool_use` and `tool_result` with `is_error`. It holds zero
   `control_request`, `control_response`, or `interrupt` entries and zero
   deltas. OAR's own rejections (`busy`, `no active turn`) never reach claude,
   so they cannot be there. Whether print mode with `stream-json` writes the
   same entries is vendor only ([sessions][native-sessions] says print mode
   persists unless `--no-session-persistence`); it was not inspected.
3. **Is a stream rebuilt from that log isomorphic to the original?** No.
   Absent from the transcript: every OAR request and response record
   (`prompt`, `steer`, `queue`, `abort`, `dispose`, `exited`, rejections),
   the control frame pairs, `seq`, and the `system/init`, `rate_limit_event`,
   and `result` frames as frames. Recoverable: message content, tool call
   pairs with their outcome, order, and the tree. A rebuild is a subset with
   a different envelope.
4. **Can a second observer attach to the same session?** On OAR's stream,
   yes and without limit: `subscribe` with a cursor replays retained records
   after `afterSeq`, then continues live (source, kernel lines 168 to 183).
   At the runtime there is no second reader of one process. Two processes
   resuming one id at the same time is unverified.
5. **Is there a recognizable last frame on process death, and what does the
   log say about an in flight tool call?** No runtime frame. The last record
   is OAR's `exited` response with `requestId ""` and code `null` (source,
   death test). The stream then holds a `tool_call_started` with no
   `tool_call_ended`. Whether the transcript holds the `tool_use` without its
   `tool_result` in that case was not probed.
6. **Do hosted forms report environment lifecycle events?** Not on OAR's
   path. The CLI exposes background, cloud, teleport, and remote control
   modes (vendor); OAR spawns none of them and has no evidence about their
   events or granularity.

### Tool call outcome reporting

Claude reports the outcome of every tool call: the `tool_result` block
carries `is_error`. Vendor: the Messages API defines the field
([tool result blocks][native-tool-result]). Observed: the recorded tool
round has `is_error: false` on its one result; the inspected transcript has
2217 `false` and 158 `true`. OAR already records the block verbatim in
`native`, and `toolResultViews` reads only `tool_use_id` and `content`
(projection lines 112 to 123), so the `result` field proposed for
`tool_call_ended` is derivable from data OAR holds today: `true` maps to
`failed`, `false` to `ok`, and an absent field means not reported.

## Verification and open gaps

[`experiments/live-contract.ts claude`](../../experiments/live-contract.ts)
covers every promise above on the real login (logs under
`oar-trial-run/live-claude-*`); the remaining
[experiments](../../experiments/README.md)
cover steering phases, abort, queue, resume, catalog and model readback.
[Vendor tests](../../sea-trial/vendor/claude.vendor.test.ts) use the real CLI
with a scripted model for tools, 400-error settlement, silent 401 retry,
approval bypass, prompt configuration through compaction and the dispose
tail. Shared [session cases](../../sea-trial/cases/session.ts) intentionally
make weaker steering/resume assertions.

Open gaps: missing-ID resume behavior, accepted-input receipt under load,
late interrupts across turns, context fullness after multi-step work, child
usage attribution and concurrent-child interleaving, and native identity
changes after conversation reset.

[native-cli]: https://code.claude.com/docs/en/cli-reference
[native-sessions]: https://code.claude.com/docs/en/agent-sdk/sessions
[native-loop]: https://code.claude.com/docs/en/agent-sdk/agent-loop
[native-input]: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
[native-output]: https://code.claude.com/docs/en/agent-sdk/streaming-output
[native-subagents]: https://code.claude.com/docs/en/agent-sdk/subagents
[native-permissions]: https://code.claude.com/docs/en/agent-sdk/permissions
[native-mcp]: https://code.claude.com/docs/en/agent-sdk/mcp
[native-tool-result]: https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use
