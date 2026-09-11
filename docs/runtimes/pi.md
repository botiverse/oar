# Pi

Reviewed **2026-09-08** against OAR source and installed SDK **0.84.2**;
mapping updated **2026-09-11** for the v2 record stream (verified with the
pi-aimock vendor tests, no live model calls). Upstream references are pinned
to **v0.84.2** (commit prefix `914cf1472`, recorded in the resume probe).
Former `badlogic/pi-mono` URLs redirect to `earendil-works/pi`. See the
[runtime index](README.md) for evidence and status conventions.

## Native concepts and calling interfaces

Pi is an extensible agent harness. Its public interfaces distinguish objects
that a generic Session abstraction can otherwise collapse:

- **Agent** runs model interactions and tools, including internal assistant/tool
  turns and steering/follow-up queues.
- **AgentSession** adds prompt handling, resources, model state, retries,
  compaction, persistence, and events around the loop.
- **SessionManager** owns a JSONL history tree. Entry IDs and parent IDs identify
  branches; the selected leaf determines active context. Branch navigation does
  not necessarily create another session file.
- **AgentSessionRuntime** replaces the active session for new/resume/fork/import
  operations and rebuilds cwd-bound services. Its session changes after
  replacement, requiring subscriptions to be rebound.
- **ModelRuntime** discovers providers/models and checks availability.
  **ResourceLoader** loads extensions and resources that can change the
  available capabilities. [SDK][native-sdk], [session format][native-format].

Programs can embed the public SDK or launch Pi's CLI, JSON mode, or RPC mode.
OAR selects the **in-process `@earendil-works/pi-coding-agent` SDK**. It creates
services and one `AgentSession`; it does not use the replacement-oriented
`AgentSessionRuntime` interface. [SDK][native-sdk],
[package overview][native-overview].

## High-level mapping to OAR

| Native concept or interface | Current OAR mapping |
|---|---|
| In-process AgentSession | One OAR Session wrapping the SDK object; no runtime subprocess. |
| Session file header ID | `Session.id`; resume resolves this ID to a file in the cwd's session directory. The record stream starts at seq 0 on every open; history is not rebuilt. |
| Agent run | A span on the stream: from the `prompt` request record (accepted once pi emits `agent_start`) to pi's own `agent_settled` event, whose `turn_ended` view carries the outcome. Several native `turn_start`/`turn_end` pairs, threshold compaction and auto-retries sit inside it. |
| Native history tree and replacement APIs | Resume is mapped; branch navigation, fork, import, and history access are not exposed. |
| ModelRuntime and ResourceLoader | Native services determine models/resources; OAR exposes selected startup options and catalog results. The effective model is a `model` view on a `pi/session_opened` event. |
| SDK event stream | Every `AgentSessionEvent` is exactly one event record, verbatim as `native`, with oar's views (text, reasoning, tool lifecycle, cumulative usage, turn end). The session-scoped events v1 dropped (compaction, queue, retry, entry, settings) are in the stream with no view. No `spanId` (pi has no native turn id); `agentPath` is always root; capabilities declare `attribution: "none"`. |
| Control | `prompt`/`steer`/`queue`/`abort`/`dispose` are request records answered accepted/rejected; `queue` is an adapter-held FIFO (`durable: false`). |

Sources: [adapter](../../packages/oar/src/runtimes/pi/session.ts),
[opener](../../packages/oar/src/runtimes/pi/open.ts),
[projection](../../packages/oar/src/runtimes/pi/projection.ts),
[agent loop][native-agent-loop], [Session contract](../../packages/oar/src/contracts/session.ts).

## Capability details

### Session creation and resume

The public SDK opens persisted sessions by **file path**. Given host-selected
`cwd`, `agentDir`, `sessionDir`, and `filePath`, OAR uses this entry shape:

```ts
const services = await createAgentSessionServices({ cwd, agentDir });
const sessionManager = SessionManager.open(filePath, sessionDir);
const { session, modelFallbackMessage } = await createAgentSessionFromServices({
  services, sessionManager,
});
```

New sessions use `SessionManager.create(cwd, sessionDir)`. The simpler
`createAgentSession({ cwd, sessionManager })` is also public; the services path
loads extension provider registrations before resolving models. Construction
returns an `AgentSession`, not a completed run.
[SDK][native-sdk], [services source][native-services-source].

**Mapped:** OAR adds ID lookup through
`await piSession(installation, { cwd, resume: sessionId })`. It calls
`SessionManager.list(cwd, sessionDir)`, matches the native header ID, and opens
the resulting path. Search is scoped to that cwd and agent directory. A missing
match throws; a session with no first message may not have a file yet.
[Resolver](../../packages/oar/src/runtimes/pi/resolve.ts).

Native construction restores active-branch context, the saved model when
available, and thinking level subject to current model capabilities. An explicit
OAR `model` overrides the saved one and is checked by readback. Without an
explicit model, native restoration can fall back; OAR discards the returned
`modelFallbackMessage`. [SDK construction][native-sdk-source].

Reopening creates a fresh record stream (seq 0), fresh observers, and an
empty adapter queue. It resumes conversation, not interrupted execution or
historical event delivery: the spec's rebuild-after-death cursor is **not
implemented** for pi. Native `session.messages`, tree navigation, fork,
and import operations are **not exposed**. Corrupt-file handling and concurrent
writers are **unverified** here.
[Adapter](../../packages/oar/src/runtimes/pi/session.ts),
[kernel](../../packages/oar/src/shared/session-kernel.ts).

### Prompt, steering, queueing, and abort

**Mapped:** `prompt()` records a request and calls `AgentSession.prompt(text)`.
The response is `accepted` once pi emits `agent_start`, or `rejected` with pi's
own message when the promise rejects first (e.g. "Cannot submit a prompt while
compaction is in progress"). The turn is the span up to pi's `agent_settled`
event — its `turn_ended` view carries completed / aborted / failed. `agent_end`
is recorded but does not end the turn: pi runs threshold compaction and auto-
retries between `agent_end` and `agent_settled` and refuses prompts meanwhile
(verified with the pi-aimock compaction recipe on 2026-09-11). Provider
failure can arrive in SDK events even when the prompt promise resolves, so the
projection carries error state into the outcome. A run pi fails after
starting, without its own settlement, is recorded as a `pi/prompt_rejected`
event carrying pi's message with a failed `turn_ended` view — pi's word, not a
synthesized boundary. Concurrent prompts are `rejected` `busy`. Native prompt
preflight callbacks and image inputs are **not exposed**.
[SDK][native-sdk], [projection](../../packages/oar/src/runtimes/pi/projection.ts).

**Partial:** `steer()` delegates to Pi and answers `accepted` on queue entry
(`rejected` `not_steerable` when no run is active). The next-turn `queue()`
uses an adapter FIFO (`capabilities.queue.durable: false`): native `followUp()`
continues the same outer run, so directly substituting it would violate OAR's
separate-turn promise. A drained input runs as a spontaneous turn (events, no
request record); if pi refuses it, the refusal is recorded as a viewless
`pi/prompt_rejected` event. Native extension commands cannot simply be queued
like ordinary text. [Agent loop][native-agent-loop],
[SDK][native-sdk], [adapter](../../packages/oar/src/runtimes/pi/session.ts).

Abort is cooperative: `abort()` delegates `AgentSession.abort()` and answers
`accepted`; the aborted outcome is pi's own `agent_settled`. `dispose()`
records the request, aborts active work, disposes the SDK session, and answers
`accepted` — pi runs in-process, so there is no process exit to record.
[Adapter](../../packages/oar/src/runtimes/pi/session.ts).

### Observation, history, and children

**Mapped:** every SDK event is one event record with the event object as
`native`; nothing is dropped. Views cover text/thinking deltas, empty
reasoning, tool start (with JSON arguments) and end (with JSON result),
cumulative token usage from assistant `message_end` usage, and the turn end.
Message boundaries, tool progress updates, compaction, queue, retry, entry and
settings events are in the stream with no view. The exhaustive projection
switch makes a new pi event type a compile error.
[Projection](../../packages/oar/src/runtimes/pi/projection.ts).

Native history includes branch/compaction records and extension data that this
stream cannot reconstruct after a reopen. `subscribe()` with a cursor replays
what this process retained; it is not a history API. The
[Pi recorder](../../sea-trial/record/pi.ts) captures SDK events for the replay
fixture. [Session format][native-format].

Subagents and MCP integration can be implemented through extensions/tools.
That does not establish a universal built-in child protocol. OAR exposes no
child graph, child control handles, or MCP configuration; individual extension
behavior through the adapter remains **unverified**.
[Package overview][native-overview].

### Models, instructions, and context

**Mapped:** initial/resume `provider/model` selection uses the extension-aware
ModelRuntime; `Session.model()` folds the `model` view of the
`pi/session_opened` event, which carries `AgentSession.model` as the SDK
reported it at open (pi exposes no later model-change event to OAR). Catalog discovery
awaits `getAvailable()` instead of reading an uninitialized snapshot. Live model
setters, thinking controls, and detailed model metadata are **not exposed**.
[Resolver](../../packages/oar/src/runtimes/pi/resolve.ts),
[catalog](../../packages/oar/src/runtimes/pi/list-models.ts).

Replace/append instructions map to ResourceLoader options; runtime metadata such
as cwd may remain. The vendor test checks prompt configuration through threshold
auto-compaction. **Mapped:** the `agent_settled` event carries a `usage` view
with native `getContextUsage()` read at that moment (post-compaction; tokens
null when unknown), so `Session.contextUsage()` — a fold — is current at turn
end. `compaction_start`/`compaction_end` are in the stream verbatim (viewless).
Explicit compact/abort-compaction controls are **not exposed**.
[Native compaction][native-compaction],
[adapter](../../packages/oar/src/runtimes/pi/session.ts),
[vendor test](../../sea-trial/vendor/pi.vendor.test.ts).

### Tools, permissions, extensions, and environment

**Partial:** `createAgentSessionServices` loads native resources and extension
provider registrations. OAR offers no general tool registration/allowlist or
extension callback interface; its custom bash tool exists to overlay environment
variables. Extensions make effective capabilities configuration-dependent.
[Native extensions][native-extensions],
[adapter](../../packages/oar/src/runtimes/pi/session.ts).

OAR pre-trusts cwd in native `trust.json`, an observable persistent write.
Extensions can still implement permission gates and interactive flows; OAR has
no general approval/user-input bridge for them. `SessionOptions.env` affects
subprocesses spawned by the replacement bash tool, not provider keys/base URLs.
Provider configuration uses native model/agent-dir channels;
`OAR_PI_AGENT_DIR` is process-level.
[Adapter](../../packages/oar/src/runtimes/pi/session.ts),
[native extensions][native-extensions].

### Process ownership, installation, and account usage

The SDK shares its host process. Global configuration and lazy environment reads
mean the adapter cannot promise independently configured embedded Pi runtimes
within one process. Releasing a session is SDK disposal, not killing a runtime
subprocess. [Adapter](../../packages/oar/src/runtimes/pi/session.ts).

**Mapped:** installation checks bundled SDK resolution/import. Native providers
support API keys and OAuth, but OAR has **no accountUsage reader** for Pi. An empty
usable-model catalog does not establish a universal unauthenticated state.
[Native providers][native-providers],
[installation](../../packages/oar/src/runtimes/pi/installation.ts),
[runtime registration](../../packages/oar/src/runtimes/pi/index.ts).

## Verification and open gaps

[Experiments](../../experiments/README.md) record import, catalog, and resume/model
readback, including real Pi resume on 2026-09-05. Older comments calling Pi resume
unimplemented are superseded by the `SessionManager.list`/`open` path and probe.
[Vendor tests](../../sea-trial/vendor/pi.vendor.test.ts) use the real SDK with a
scripted model for errors, tools, context at turn end, compaction events in the
stream, and prompt configuration through compaction; they passed on the v2
adapter on 2026-09-11 (macOS, SDK 0.84.2). The
[replay test](../../tests/replay/pi-projection.test.ts) pins the fold over the
recorded tool-round fixture and the settled/abort/error classification.

Priority gaps are accepted steering through retry/compaction, distinct queued
turns under races, extension-generated activity, unavailable saved-model
fallback, and whether `agent_settled` always follows an aborted or failed run
(the abort path was exercised only through the mock fixture, not live pi).

[native-sdk]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md
[native-format]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/session-format.md
[native-compaction]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/compaction.md
[native-extensions]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md
[native-providers]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/providers.md
[native-overview]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/README.md
[native-agent-loop]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/agent-loop.ts
[native-services-source]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session-services.ts
[native-sdk-source]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/sdk.ts
