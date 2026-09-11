# Pi

Evidence baseline: OAR source as of 2026-09-11. Native references are pinned
to pi **v0.84.2** (commit prefix `914cf1472`; former `badlogic/pi-mono` URLs
redirect to `earendil-works/pi`), the version of the bundled
`@earendil-works/pi-coding-agent` SDK **0.84.2**. Live observations come from
that SDK in-process through [`experiments/live-contract.ts pi`](../../experiments/live-contract.ts)
against `openai-codex/gpt-5.3-codex-spark` (codex OAuth through pi; every
assistant frame carries `provider: "openai-codex"`, `api:
"openai-codex-responses"`) on Node 26.7 / macOS, and from the probes in
the [experiments index](../../experiments/README.md). Versions are evidence
baselines, not a support range. See the [runtime index](README.md) for
evidence and status conventions.

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
| ModelRuntime and ResourceLoader | Native services determine models/resources; OAR exposes selected startup options and catalog results. The effective model is a `model` view on a `pi/session_opened` event. Outside sessions, `createPiProviderAuth` wraps `ModelRuntime.login`/`logout`/auth status and `createPiModelCatalog` wraps `ModelRegistry` (providers, model metadata, refresh). |
| SDK event stream | Every `AgentSessionEvent` is exactly one event record, verbatim as `native`, with oar's views (text, reasoning, tool lifecycle, cumulative usage, turn end). The session-scoped events (compaction, queue, retry, entry, settings) are in the stream with no view. No `spanId` (pi has no native turn id); `agentPath` is always root; capabilities declare `attribution: "none"`. |
| Control | `prompt`/`steer`/`queue`/`abort`/`dispose` are request records answered accepted/rejected; `queue` is an adapter-held FIFO (`durable: false`). `abort` is answered at delivery, ahead of pi's own aborted `agent_settled`. |
| Provider HTTP | Before the first provider request the adapter sets undici's global dispatcher to an `EnvHttpProxyAgent` (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, pi's `httpProxy` setting as the fallback, pi's idle timeout): the proxy half of what every pi entry point installs, without pi's global fetch replacement; process-global. |

Sources: [adapter](../../packages/oar/src/runtimes/pi/session.ts),
[opener](../../packages/oar/src/runtimes/pi/open.ts),
[projection](../../packages/oar/src/runtimes/pi/projection.ts),
[HTTP plane](../../packages/oar/src/runtimes/pi/http.ts),
[provider auth](../../packages/oar/src/runtimes/pi/auth.ts),
[catalog](../../packages/oar/src/runtimes/pi/catalog.ts),
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
`await piSession(installation, { cwd, resume: sessionId })`. The session
directory is pi's per-cwd formula, `<agentDir>/sessions/--<cwd slug>--`
(mirrored by the adapter so the agent-dir pin and pi's own CLI land sessions
in the same place); the adapter calls `SessionManager.list(cwd, sessionDir)`,
matches the native header ID, and opens the resulting path. Search is scoped
to that cwd and agent directory: a session started elsewhere is not found, and
the error names the directory searched. A missing match throws; pi writes the
file on the first message, so a session that never received one has no file.
Live, resume by the header id finds the file, keeps the id, and the earlier
transcript is recalled (`resume` scenario; also
[`session-resume.ts`](../../experiments/README.md)). The directory formula,
lookup and its error are pinned by
[`tests/pi/pi-session-resume.test.ts`](../../tests/pi/pi-session-resume.test.ts).
[Resolver](../../packages/oar/src/runtimes/pi/resolve.ts).

Native construction restores active-branch context, the saved model when
available, and thinking level subject to current model capabilities. An explicit
OAR `model` overrides the saved one and is checked by readback; without one, the
recorded model is restored (the resumed stream starts with only
`pi/session_opened → model` carrying the model from the file). Native
restoration can fall back when the saved model is unavailable; OAR discards the
returned `modelFallbackMessage`. [SDK construction][native-sdk-source].

Reopening creates a fresh record stream (seq 0), fresh observers, and an
empty adapter queue. It resumes conversation, not interrupted execution or
historical event delivery: the spec's rebuild-after-death cursor is **not
implemented** for pi. Native `session.messages`, tree navigation, fork,
and import operations are **not exposed**. Corrupt-file handling and concurrent
writers are **unverified**.
[Adapter](../../packages/oar/src/runtimes/pi/session.ts),
[kernel](../../packages/oar/src/shared/session-kernel.ts).

### Prompt, steering, queueing, and abort

**Mapped:** `prompt()` records a request and calls `AgentSession.prompt(text)`.
The response is `accepted` once pi emits `agent_start`, or `rejected` with pi's
own message when the promise rejects first (e.g. "Cannot submit a prompt while
compaction is in progress"). The turn is the span up to pi's `agent_settled`
event: its `turn_ended` view carries completed / aborted / failed. `agent_end`
is recorded but does not end the turn: pi runs threshold compaction and auto-
retries between `agent_end` and `agent_settled` and refuses prompts meanwhile
(pinned with the pi-aimock compaction recipe in the
[vendor test](../../sea-trial/vendor/pi.vendor.test.ts)). Provider failure
can arrive in SDK events even when the prompt promise resolves (a 400 surfaces
only as `stopReason: "error"` on the turn's final assistant message and the
`message_update` error frame), so the projection carries error state into the
outcome. A run pi fails after starting, without its own settlement, is
recorded as a `pi/prompt_rejected` event carrying pi's message with a failed
`turn_ended` view, pi's word, not a synthesized boundary. A second prompt
during a run is `rejected` `busy` (`busy-and-late-control` scenario). Native
prompt preflight callbacks and image inputs are **not exposed**.
[SDK][native-sdk], [projection](../../packages/oar/src/runtimes/pi/projection.ts).

**Steer (partial, landing observed):** `steer()` delegates to
`AgentSession.steer()` and answers `accepted` on queue entry (`rejected`
`not_steerable: no active turn` when no run is active). Natively the steer is
a `queue_update` event with the text under `steering`, inside the running
span; the run's next internal turn drains it (a `queue_update` with empty
lists) and injects it as a user message, and the text lands in the same
turn's final reply with one `turn_ended` (`steer` scenario: the final text
combined the prompt's and the steer's words). Acceptance means entry into
pi's queue, not model receipt.

**Queue (partial):** `queue()` uses an adapter FIFO
(`capabilities.queue.durable: false`): native `followUp()` continues the same
outer run, so directly substituting it would violate OAR's separate-turn
promise. The FIFO is drained one input per run end; a drained input runs as a
spontaneous turn: `agent_settled`, then `agent_start` with no request record
of its own, and its reply ends its own turn (`queue` scenario). If pi refuses
the drained input, the refusal is recorded as a viewless `pi/prompt_rejected`
event. Native extension commands cannot simply be queued like ordinary text.
[Agent loop][native-agent-loop], [SDK][native-sdk],
[adapter](../../packages/oar/src/runtimes/pi/session.ts).

**Abort (mapped, cooperative):** `abort()` delivers with pi's two public
synchronous calls, `AgentSession.abortRetry()` then
`AgentSession.agent.abort()` (exactly what pi's own
`AgentSession.abort()` does before it awaits idle) and answers
`accepted` at delivery, ahead of the turn end; the idle wait is
deliberately not part of the answer (awaiting it
would put the `accepted` response behind `agent_settled`). As for every
adapter, an `accepted` abort means the abort was delivered, not that the turn
has ended: callers `awaitTurnEnd` before the next prompt, or the prompt is
`rejected` `busy` while pi is still settling. The aborted outcome is pi's own
`agent_settled`. What pi does on abort: the running tool ends with result text
`Command aborted`, pi still starts the next internal turn, whose assistant
message arrives with `stopReason: "error"` / `errorMessage: "This operation
was aborted"`, then `agent_end`, then `agent_settled`; the projection's abort
intent outranks that error, so the `turn_ended` view is `aborted`, not
`failed`. A late abort is `rejected` `no active turn`. The ordering
(`request:abort`, `response:accepted`, `tool_call_ended`,
`turn_ended:aborted`) is pinned by the [vendor test](../../sea-trial/vendor/pi.vendor.test.ts)
and observed live (`abort` scenario); the classification by the
[replay test](../../tests/replay/pi-projection.test.ts).

**Dispose:** `dispose()` records the request, clears the held queue, aborts
active work (this time awaiting pi's idle), disposes the SDK session, and
answers `accepted` after pi's aborted `agent_settled`: mid-run the stream
reads `dispose`, pi's `Command aborted` tool end, the aborted `agent_settled`,
then `accepted` (`dispose-mid-turn` scenario). Pi runs in-process, so there is
no process exit to record. Afterwards `prompt`/`steer`/`queue` are `rejected`
`session disposed` and `abort` `no active turn`.
[Adapter](../../packages/oar/src/runtimes/pi/session.ts).

### Observation, history, and children

**Mapped:** every SDK event is one event record with the event object as
`native`; nothing is dropped. Views cover text/thinking deltas, empty
reasoning, tool start (with JSON arguments) and end (with JSON result),
cumulative token usage from assistant `message_end` usage, and the turn end.
Message boundaries, tool progress updates, compaction, queue, retry, entry and
settings events are in the stream with no view. The exhaustive projection
switch makes a new pi event type a compile error. Live shape on the baseline
model: a one-shot turn is 17 records, seq dense, views `model`, `reasoning`,
`text_delta`, `usage`, `turn_ended`, no `spanId` (`basic` scenario);
`gpt-5.3-codex-spark` streams `thinking_start`/`thinking_end` with no deltas,
so its reasoning view is `reasoning` `empty`, never text; `tool_call_started`
input is pi's `args` as JSON (`{"command":"echo …"}`), `tool_call_ended`
output is pi's `result` (`{"content":[{"type":"text","text":"…"}]}`), the
callIds match, and pi's callId for this provider is the codex Responses pair
`call_…|fc_…` (`tool-detail` scenario). The fold over a recorded tool round
is pinned by the [replay test](../../tests/replay/pi-projection.test.ts);
the tool framing by the [vendor test](../../sea-trial/vendor/pi.vendor.test.ts).
[Projection](../../packages/oar/src/runtimes/pi/projection.ts).

Native history includes branch/compaction records and extension data that this
stream cannot reconstruct after a reopen. `subscribe()` with a cursor replays
what this process retained and continues live, contiguous with the retained
log; a from-start replay equals `records()` (`cursor` scenario). It is not a
history API. The [Pi recorder](../../sea-trial/record/pi.ts) captures SDK
events for the replay fixture. [Session format][native-format].

Subagents and MCP integration can be implemented through extensions/tools.
That does not establish a universal built-in child protocol. OAR exposes no
child graph, child control handles, or MCP configuration; individual extension
behavior through the adapter remains **unverified**. The battery's `subagent`
scenario is skipped for pi (no native sub-agents).
[Package overview][native-overview].

### Models, instructions, and context

**Mapped:** initial/resume `provider/model` selection uses the extension-aware
ModelRuntime; `Session.model()` folds the `model` view of the
`pi/session_opened` event, which carries `AgentSession.model` as the SDK
reported it at open (pi exposes no later model-change event to OAR). The
adapter checks the spelling before pi is asked: a bare `oar-no-such-model-xyz`
fails the `provider/model` check, while `openai-codex/oar-no-such-model-xyz`
or `no-such-provider/gpt-5.3-codex-spark` throws "is not registered" from
`ModelRuntime.getModel`: no session, no tokens (`bad-model` scenario;
[`tests/pi/pi-session-resume.test.ts`](../../tests/pi/pi-session-resume.test.ts),
[`tests/pi/pi-session-model.test.ts`](../../tests/pi/pi-session-model.test.ts)).
Catalog discovery (`oar models pi`) builds services the way `pi --list-models`
does and awaits `getAvailable()` instead of reading an uninitialized snapshot;
"nothing configured" is an `ok` empty list. Live model setters, thinking
controls, and detailed model metadata are **not exposed** on the session
(`createPiModelCatalog` reads metadata outside it).
[Resolver](../../packages/oar/src/runtimes/pi/resolve.ts),
[catalog](../../packages/oar/src/runtimes/pi/list-models.ts),
[readback probe](../../experiments/README.md).

Replace/append instructions map to ResourceLoader options (`systemPrompt`,
`appendSystemPrompt`). **Replace is not the whole system prompt:** pi's
`buildSystemPrompt` (`core/system-prompt.js`, `customPrompt` branch) keeps its
runtime-native additions around the replaced text: the append seam, then the
project context files (`<project_context>`, AGENTS.md bodies), then the skills
catalog (`<available_skills>`: the agent dir's skills and the host's
`~/.agents/skills` via `package-manager.js` `loadSkills`, when the read tool
is present), then the `Current working directory:` line. The adapter leaves
those in place, like codex's skills catalog around `baseInstructions`: the
resource-loader `noSkills` option would drop every skill (project ones too),
which is more than a prompt replacement. The vendor test checks prompt
configuration through threshold auto-compaction and cuts the host-skills
block before its snapshot, since that block is the host's, present or absent
per machine.

**Mapped:** the `agent_settled` event carries a `usage` view with native
`getContextUsage()` read at that moment (post-compaction; tokens null when
unknown), so `Session.contextUsage()` (a fold) is current at turn end.
`usage()` is the cumulative per-session total; its input counts pi's
`input + cacheRead + cacheWrite`, and one `turn_ended` is recorded per prompt
with totals growing across turns (live on the baseline model: a one-shot turn
`{input: 1381, output: 39}` with `contextUsage()` `{tokens: 1420,
contextWindow: 128000}`; three turns 1377 → 2772 → 4186 input;
`basic`/`multi-turn` scenarios). `compaction_start`/`compaction_end` are in
the stream verbatim (viewless); they are pinned with the pi-aimock recipe
(tiny `contextWindow` plus fat reported usage plus compaction settings) and
have not been reached with a real provider: live contexts stay near 1.4k of
128k tokens. Explicit compact/abort-compaction controls are **not exposed**.
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

### HTTP plane and proxies

Every pi entry point (`cli.js`, `rpc-entry.js`, `main.js`) calls its
`configureHttpDispatcher()` before a provider request: an undici
`EnvHttpProxyAgent` honoring `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (plus the
global `httpProxy` setting copied into the env, pi's idle timeouts) **and**
`undici.install()`, which replaces `globalThis.fetch`/`Headers`/`Request`/
`Response`/`WebSocket`/`FormData` for the whole process. The public SDK entry
does none of this: on Node's default dispatcher, which ignores proxy env, an
embedded pi behind `HTTPS_PROXY` fails every provider call through pi's own
auto-retry (`auto_retry_start` ×3, `auto_retry_end` `finalError: "fetch
failed"`, `agent_settled` → `failed`) while the `pi` CLI works.

**Mapped, narrowly:** the adapter does not call pi's module (unexported, and
its global-class replacement is no footprint for an embedding library). It
sets undici's global dispatcher itself (`undici` is a direct dependency of
`@botiverse/oar`, pinned to the version pi uses, 8.9.0 with one instance in
the tree) to an `EnvHttpProxyAgent` built from the same settings manager the
session, model listing, login and catalog entry points read
(`OAR_PI_AGENT_DIR ?? getAgentDir()`): an env proxy wins, pi's `httpProxy`
setting fills both http and https when the env names none (pi's own `??=`
precedence, but the env is not written), and pi's `httpIdleTimeoutMs`
setting is the dispatcher's headers/body timeout (pi's default equals
undici's). Node's own `fetch` reads that dispatcher through
`Symbol.for("undici.globalDispatcher.1")`, so the global fetch classes stay
Node's; compressed bodies still decode (Node 26.7 bundles the same undici
8.9.0), and the live battery reaches the provider through it from a host with
`HTTPS_PROXY` set. Not taken from pi's plane: `undici.install()`, the
`"error"` listener pi puts on every undici client, the `allowH2`/connect
tuning. When undici cannot be loaded the adapter emits one
`OAR_PI_PROXY_PLANE` process warning and the session runs on Node's default
dispatcher; the failed load is not cached, so a later entry point retries.
The dispatcher is process-global by nature. Precedence, proxying through a
local stand-in, the untouched env, and the untouched global classes are
pinned by [`tests/pi/pi-http.test.ts`](../../tests/pi/pi-http.test.ts).
[HTTP plane](../../packages/oar/src/runtimes/pi/http.ts).

### Process ownership, installation, login, and account usage

The SDK shares its host process. Global configuration, lazy environment reads
and the global dispatcher mean the adapter cannot promise independently
configured embedded Pi runtimes within one process. Releasing a session is SDK
disposal, not killing a runtime subprocess; the battery's `kill-runtime`
scenario is skipped for pi. [Adapter](../../packages/oar/src/runtimes/pi/session.ts).

**Mapped:** installation checks bundled SDK resolution/import; there is no
executable to probe and no version to report. Native providers support API
keys and OAuth; `createPiProviderAuth` exposes per-provider status, interactive
login (auth-URL / device-code / prompt events bridged from pi's
`AuthInteraction`), `setApiKey`, and logout through `ModelRuntime`, outside the
runtime's session interface. OAR has **no accountUsage reader** for Pi: it
runs on provider credentials and has no subscription usage surface to observe.
An empty usable-model catalog does not establish a universal unauthenticated
state.
[Native providers][native-providers],
[installation](../../packages/oar/src/runtimes/pi/installation.ts),
[provider auth](../../packages/oar/src/runtimes/pi/auth.ts),
[runtime registration](../../packages/oar/src/runtimes/pi/index.ts).

## Verification and open gaps

[`experiments/live-contract.ts pi`](../../experiments/live-contract.ts) runs
eleven scenarios on the real login (`basic`, `multi-turn`, `tool-detail`,
`busy-and-late-control`, `steer`, `queue`, `abort`, `dispose-mid-turn`,
`cursor`, `resume`, `bad-model`; `subagent` and `kill-runtime` are skipped:
no native sub-agents, in-process runtime). The remaining
[experiments](../../experiments/README.md) cover SDK import, catalog
(`pi-list-models.ts`), resume and model readback (`session-resume.ts`,
`session-model-readback.ts`).
[Vendor tests](../../sea-trial/vendor/pi.vendor.test.ts) use the real SDK
with a scripted model (pi-aimock) for the 400 error edge, a two-round tool
conversation, prompt configuration through threshold compaction with
`compaction_*` in the stream, abort answered ahead of the aborted turn end,
and context at turn end with every SDK event one record. The
[replay test](../../tests/replay/pi-projection.test.ts) pins the fold over the
recorded tool-round fixture and the settled/abort/error classification; the
unit tests under [`tests/pi/`](../../tests/pi/) pin the session-directory
formula, id lookup, model spelling/resolution, model readback, and the HTTP
plane.

Open gaps: accepted steering through retry/compaction; distinct queued turns
under races; extension-generated activity (children, permission gates,
commands); unavailable saved-model fallback on resume; threshold compaction
with a real provider (only the pi-aimock recipe exercises `compaction_*`);
corrupt session files and concurrent writers; and the rebuild-after-death
cursor, which is not implemented.

[native-sdk]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md
[native-format]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/session-format.md
[native-compaction]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/compaction.md
[native-extensions]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md
[native-providers]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/providers.md
[native-overview]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/README.md
[native-agent-loop]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/agent-loop.ts
[native-services-source]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session-services.ts
[native-sdk-source]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/sdk.ts
