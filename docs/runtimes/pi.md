# Pi

Reviewed **2026-09-08** against current OAR source and installed SDK **0.84.2**.
Upstream references are pinned to **v0.84.2** (commit prefix `914cf1472`, recorded
in the resume probe). Former `badlogic/pi-mono` URLs redirect to
`earendil-works/pi`. No runtime tests or model calls were made for this review.
See the [runtime index](README.md) for evidence and status conventions.

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
| Session file header ID | `Session.id`; resume resolves this ID to a file in the cwd's session directory. |
| Agent run | One OAR Turn spanning potentially several native `turn_start`/`turn_end` pairs. |
| Native history tree and replacement APIs | Resume is mapped; branch navigation, fork, import, and history access are not exposed. |
| ModelRuntime and ResourceLoader | Native services determine models/resources; OAR exposes selected startup options and catalog results. |
| SDK event stream | Selected text/reasoning/tool events; session events and richer details are dropped. |

Sources: [adapter](../../packages/oar/src/runtimes/pi/session.ts),
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

Reopening creates fresh OAR observers, turn handles, sequence numbers, and an
empty adapter queue. It resumes conversation, not interrupted execution or
historical event delivery. Native `session.messages`, tree navigation, fork,
and import operations are **not exposed**. Corrupt-file handling and concurrent
writers are **unverified** here.
[Adapter](../../packages/oar/src/runtimes/pi/session.ts),
[kernel](../../packages/oar/src/shared/session-kernel.ts).

### Prompt, steering, queueing, and abort

**Mapped:** OAR starts a kernel turn and awaits `AgentSession.prompt(text)`.
One OAR turn covers the outer run, potentially many native turns; `agent_end`
and prompt completion provide its boundary. Provider failure can arrive in
SDK events even when the prompt promise resolves, so OAR's projection records
error state. Concurrent OAR prompts return `busy`. Native prompt preflight
callbacks and image inputs are **not exposed**.
[SDK][native-sdk], [projection](../../packages/oar/src/runtimes/pi/projection.ts).

**Partial:** OAR `steer()` delegates to Pi and acknowledges queue acceptance.
Its next-turn queue instead uses an adapter FIFO with `durable: false`: native
`followUp()` continues the same outer run, so directly substituting it would
violate OAR's separate-turn promise. Native extension commands cannot simply be
queued like ordinary text. [Agent loop][native-agent-loop],
[SDK][native-sdk], [adapter](../../packages/oar/src/runtimes/pi/session.ts).

Abort is cooperative: OAR delegates `AgentSession.abort()` and waits for its
outcome. Disposal aborts active work and disposes the SDK session.
[Adapter](../../packages/oar/src/runtimes/pi/session.ts).

### Observation, history, and children

**Partial:** OAR projects text/thinking deltas and tool start/end IDs. Available
tool arguments/results, incremental updates, message boundaries, retries, and
session events are dropped. Typed event handling makes those choices explicit;
it does not make the output lossless.
[Projection](../../packages/oar/src/runtimes/pi/projection.ts).

Native history includes branch/compaction records and extension data that this
stream cannot reconstruct. `subscribe()` is not a history API. The
[Pi recorder](../../sea-trial/record/pi.ts) captures SDK events for tests, not a
public raw/replay surface. [Session format][native-format];
[v2 records](../spec/README.md) remain draft work.

Subagents and MCP integration can be implemented through extensions/tools.
That does not establish a universal built-in child protocol. OAR exposes no
child graph, child control handles, or MCP configuration; individual extension
behavior through the adapter remains **unverified**.
[Package overview][native-overview].

### Models, instructions, and context

**Mapped:** initial/resume `provider/model` selection uses the extension-aware
ModelRuntime; `model()` reads the native effective model. Catalog discovery
awaits `getAvailable()` instead of reading an uninitialized snapshot. Live model
setters, thinking controls, and detailed model metadata are **not exposed**.
[Resolver](../../packages/oar/src/runtimes/pi/resolve.ts),
[catalog](../../packages/oar/src/runtimes/pi/list-models.ts).

Replace/append instructions map to ResourceLoader options; runtime metadata such
as cwd may remain. The vendor test checks prompt configuration through threshold
auto-compaction. **Partial:** `contextUsage()` delegates native `getContextUsage()`,
preserving unknown tokens after compaction. Explicit compact/abort-compaction
controls and lifecycle events are **not exposed**.
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
scripted model for errors, tools, context shape, and prompt configuration through
compaction. They were not rerun for this review.

Priority gaps are accepted steering through retry/compaction, distinct queued
turns under races, extension-generated activity, unavailable saved-model fallback,
and observation of session events without an active turn.

[native-sdk]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md
[native-format]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/session-format.md
[native-compaction]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/compaction.md
[native-extensions]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md
[native-providers]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/providers.md
[native-overview]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/README.md
[native-agent-loop]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/agent-loop.ts
[native-services-source]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session-services.ts
[native-sdk-source]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/sdk.ts
