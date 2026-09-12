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

### Native identity, the peer registry, and declared capability, probed live

Observations in this subsection come from **2.1.237** and **2.1.261** on linux
x64, probed 2026-09-12 outside OAR. They describe the runtime's own local
surfaces, not adapter behaviour.

**Identity is the live process, not the connection.** Session identity is a UUID
that names the session JSONL file, and it is minted by the runtime process
itself and registered locally; no central authority issues it. Runtime identity
is separate and is a triple, `(pidDomain, pid, procStart)`, plus one socket per
process at `cc-socks/<pid>.sock`. The socket path is the address, so what is
addressable is a process, not a connection. `pidDomain` carries a PID-namespace
inode, which keeps two containers from colliding, and `procStart` guards against
PID reuse, so the triple is host local while the session UUID is globally
unique. The two layers have different lifetimes.

**Discovery is peer to peer and the registry is never collected.** There is no
broker: an observer reads `~/.claude/sessions/` and then connects to the peer's
socket. `sessions/<pid>.json` is not removed when the process dies, and 52 empty
`session-env/<uuid>/` directories were still present from processes long gone.
A reader therefore has to verify liveness itself, against the socket or against
`procStart`; the presence of a registry entry means nothing. Locally, PID
1360120's entry was still there with no such process.

**`peerFeatures` is honest capability reporting.** A peer does not assume what
the other side can do, it reads the feature list the other side reports. The
list also grows with the version: one entry on 2.1.237, three on 2.1.261, and
running both versions on one machine makes the version drift directly visible.
Among the four harnesses probed in this comparison this is the only capability
surface that behaves this way.

Not observed on these builds: log completeness at process death, whether a
rebuilt session is isomorphic to the original, and any environment-lifecycle
concept, which the runtime does not appear to have.

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

Also open on the linux 2.1.237/2.1.261 probes: the resumability floor of a
session JSONL, log completeness at process death, whether a rebuilt session is
isomorphic to the original, and whether anything ever collects
`sessions/<pid>.json` or `session-env/<uuid>/`.

[native-cli]: https://code.claude.com/docs/en/cli-reference
[native-sessions]: https://code.claude.com/docs/en/agent-sdk/sessions
[native-loop]: https://code.claude.com/docs/en/agent-sdk/agent-loop
[native-input]: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
[native-output]: https://code.claude.com/docs/en/agent-sdk/streaming-output
[native-subagents]: https://code.claude.com/docs/en/agent-sdk/subagents
[native-permissions]: https://code.claude.com/docs/en/agent-sdk/permissions
[native-mcp]: https://code.claude.com/docs/en/agent-sdk/mcp
