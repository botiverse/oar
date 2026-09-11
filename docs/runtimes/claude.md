# Claude Code

Reviewed **2026-09-08** against current OAR source and official documentation.
Recorded binary observations cover **2.1.237** (2026-08-21) and **2.1.261**
(model readback, 2026-09-05). Official documentation is rolling; those observations
are not a support range. No runtime tests or model calls were made for this review.
See the [runtime index](README.md) for evidence and status conventions.

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

| Native concept or interface | Current OAR mapping |
|---|---|
| CLI process | One owned subprocess per OAR Session; stdio carries inputs, controls, and events. |
| Persistent session ID | `Session.id`; supplied through `--session-id` or `--resume`. |
| User turn and result | One OAR Turn, with an OAR-generated ID; `result` settles its outcome. |
| Model steps, messages, tool calls | Selected text/reasoning/tool events within that OAR Turn. Tool IDs survive; message identity generally does not. |
| Subagent conversation | No child Session or control handle; current projection ignores parent attribution. |
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
once the process is spawned, **before a native resume acknowledgment**. Submit a
prompt and inspect its outcome; startup alone does not establish successful
history restoration. The reopened adapter has fresh observers, turn IDs,
sequence numbers, and an empty queue. It supplies startup options again and does
not restore old control handles or historical OAR events.
[Adapter](../../packages/oar/src/runtimes/claude/session.ts),
[kernel](../../packages/oar/src/shared/session-kernel.ts).

Fork, session listing, history retrieval, rewind, and reset identity management
are **not exposed**. Missing-ID error timing, duplicate transcripts, and concurrent
controllers resuming one ID remain **unverified**.

### Prompt, steering, queueing, and abort

**Mapped:** `prompt(string)` starts one OAR turn; another prompt returns `busy`
while it runs. A spontaneous `system/init` after settlement can open another
turn. `result` ends the current turn.
[Projection](../../packages/oar/src/runtimes/claude/projection.ts).

**Partial:** `steer()` writes stdin. `accepted` transfers delivery responsibility
to the adapter; it does not prove model receipt or same-turn landing. Recorded
multi-step runs absorb input at a later step; input arriving too late becomes a
subsequent turn. OAR's separate next-turn FIFO is adapter-held and explicitly
`durable: false`. `abort()` sends `control_request/interrupt`, waits for the result,
and uses its own abort intent to classify that result.
[Phase probe](../../experiments/claude-stream-json-phases.ts),
[adapter probe](../../experiments/claude-session-adapter.ts),
[queue probe](../../experiments/session-queue.ts).

### Observation, children, and history

**Partial:** text blocks become `text_delta`; reasoning retains text, redacted,
and empty distinctions; tools retain IDs and available input/output. OAR does
not request `--include-partial-messages`, so `text_delta` does not imply
token-level streaming. [Native streaming][native-output],
[projection](../../packages/oar/src/runtimes/claude/projection.ts).

Child lifecycle is **not exposed**. The projection ignores `parent_tool_use_id`;
recognized child messages would share the active OAR turn, and out-of-turn
messages are dropped. Exact child ordering on the selected binary/flags remains
**unverified**, even though native SDK documentation establishes child identity.
[Native subagents][native-subagents].

The projection also drops message identity, unknown payloads, input echoes,
control replies, and telemetry. `subscribe()` is live observation, not a history
API. The [recording helper](../../sea-trial/record/claude.ts) scrubs frames for
projection tests; it is not a public raw/replay interface.
[v2 records](../spec/README.md) remain draft work.

### Models, instructions, and context

**Mapped:** `--model` selects the initial model; `model()` reads the native
`system/init.model`, initially `null`. The token-free `list_models` control request
preserves selector versus resolved ID, disabled entries, and effort choices.
Live model/effort setters are **not exposed**.
[Catalog](../../packages/oar/src/runtimes/claude/list-models.ts),
[readback probe](../../experiments/session-model-readback.ts).

Replace/append instructions map to native system-prompt flags; native harness
metadata may remain alongside replacement text. The existing vendor test checks
that the configured instructions survive manual `/compact`.
[Adapter](../../packages/oar/src/runtimes/claude/session.ts),
[vendor test](../../sea-trial/vendor/claude.vendor.test.ts).

Context reporting is **partial**. OAR caches result input/cache counts and the
first model's context window, but official documentation describes result usage
as aggregate main-loop usage for the user turn. That calculation is therefore
**unverified as current context fullness** across multiple model steps. Native
compaction still runs; OAR drops its lifecycle and cost details.
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

## Verification and open gaps

[Experiments](../../experiments/README.md) record steering, abort, queue, resume,
catalog, and model readback. [Vendor tests](../../sea-trial/vendor/claude.vendor.test.ts)
use the real CLI with a scripted model to cover tools, 400-error settlement,
silent 401 retry, approval bypass, and prompt configuration through compaction.
The context test checks shape. Shared [session cases](../../sea-trial/cases/session.ts)
intentionally make weaker steering/resume assertions. These were not rerun here.

Priority gaps are missing-ID resume behavior, accepted-input receipt, child
activity after a main result, late interrupts across turns, context fullness
after multi-step work, and native identity changes after conversation reset.

[native-cli]: https://code.claude.com/docs/en/cli-reference
[native-sessions]: https://code.claude.com/docs/en/agent-sdk/sessions
[native-loop]: https://code.claude.com/docs/en/agent-sdk/agent-loop
[native-input]: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
[native-output]: https://code.claude.com/docs/en/agent-sdk/streaming-output
[native-subagents]: https://code.claude.com/docs/en/agent-sdk/subagents
[native-permissions]: https://code.claude.com/docs/en/agent-sdk/permissions
[native-mcp]: https://code.claude.com/docs/en/agent-sdk/mcp
