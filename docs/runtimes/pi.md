# Pi

Independent inventories (2026-09-16): resource-loader skills, and registered
tools with parameter schemas and active membership. Core MCP discovery is
unsupported. See the [query contract](../spec/inventory.md) and
[native probe evidence](inventory.md).

Evidence baseline: OAR source as of 2026-09-11; bundled
`@earendil-works/pi-coding-agent` SDK **1.0.4**. Native source references are
pinned to pi **v0.84.2** (commit prefix `914cf1472`; former `badlogic/pi-mono`
URLs redirect to `earendil-works/pi`). Live observations below are from SDK
**0.84.2** unless they name a version or date (the bundled SDK moved to 0.87.1
on 2026-09-29, 0.99.1 on 2026-09-30, 0.99.2 on 2026-10-01, 1.0.0 on
2026-10-02, 1.0.2 on 2026-10-04, 1.0.3 on 2026-10-05 and 1.0.4 on
2026-10-06): in-process runs of
[`experiments/live-contract.ts pi`](../../experiments/live-contract.ts) and the
[experiments index](../../experiments/README.md) probes against
`openai-codex/gpt-5.3-codex-spark` (codex OAuth through pi; every assistant
frame carries `provider: "openai-codex"`, `api: "openai-codex-responses"`) on
Node 26.7 / macOS. Versions are evidence baselines, not a support range; see
the [runtime index](README.md) for conventions.

On **1.0.2** (2026-10-04; Linux x64, Node 24.19.0,
`exe-dev-openai/gpt-6-luna@llm`) all 11 applicable live cases passed
(subagents and process killing inapplicable), the simulated-provider behavior
suite was 19/19 clean, withdrawal included, and all eight applicable vendor
tests passed without adapter changes; the live battery and both suites had
passed on 1.0.0 too (2026-10-02). A separate-process probe
([`pi-upgrade-resume.ts`](../../experiments/pi-upgrade-resume.ts)) resumed a
session created by the previous SDK, 0.99.2 under 1.0.0 and 1.0.0 under
1.0.2: native id, saved model and prior transcript survived, and the new OAR
stream started at sequence zero. This checks conversation continuity, not
unfinished execution recovery. Neither upgrade adopts the separate
experimental Pi Durable harness. Scope, commands and evidence: version check
reports of [October 2](../../experiments/runtime-version-checks/2026-10-02.md)
and [October 4](../../experiments/runtime-version-checks/2026-10-04.md).

On **1.0.3** (2026-10-05; same Linux/Node/provider as the 1.0.2 run),
the 11 applicable live cases and eight vendor tests passed again, the
19-case simulated behavior suite was clean (17 passed, two skipped), and
ordinary 1.0.2 to 1.0.3 cross-process resume passed.
The OAR dependency range remained `^1.0.2`; that check selected 1.0.3.
See the [October 5 report](../../experiments/runtime-version-checks/2026-10-05.md).

On **1.0.4** (2026-10-06; same Linux/Node/provider), all 11 applicable
live cases passed, with `tool-detail` passing on a targeted retry after an
upstream overload response. The other ten passed on the first run. All eight
vendor tests and the 19-case simulated behavior suite passed or skipped only
inapplicable cases. Separate-process 1.0.3 to 1.0.4 resume preserved the id,
model and prior transcript; the new stream began at sequence zero. No adapter
change was needed. The workspace lock now selects 1.0.4 and OAR's dependency
ranges remain `^1.0.2`. See the
[October 6 report](../../experiments/runtime-version-checks/2026-10-06.md).

**Azure migration in 1.0.3:** the native provider was renamed from
`azure-openai-responses` to `azure`. Update the native auth, model and
settings provider keys and the prefix in `SessionOptions.model`. When
resuming an old Azure session, explicitly pass `model: "azure/<model>"`:
without it, Pi can preserve the session id and history while changing to
an available default model. OAR's opening `model` event and `Session.model()`
report that effective fallback, not the saved old provider. Explicitly
requesting the removed provider rejects at open. The
[`pi-azure-upgrade-resume.ts`](../../experiments/pi-azure-upgrade-resume.ts)
probe verifies these outcomes with a native 1.0.2 session file containing
synthetic messages and a scripted fallback provider, not an Azure network
request. Azure authentication and prompt-cache behavior were not tested.

## Native concepts and calling interfaces

Pi is an extensible agent harness. Its public interfaces distinguish objects
that a generic Session abstraction can otherwise collapse:

- **Agent** runs model interactions and tools, including internal
  assistant/tool turns and steering/follow-up queues.
- **AgentSession** adds prompt handling, resources, model state, retries,
  compaction, persistence and events around the loop.
- **SessionManager** owns a JSONL history tree. Entry IDs and parent IDs
  identify branches; the selected leaf determines active context. Branch
  navigation does not necessarily create another session file.
- **AgentSessionRuntime** replaces the active session for
  new/resume/fork/import and rebuilds cwd-bound services; subscriptions must
  be rebound after a replacement.
- **ModelRuntime** discovers providers/models and checks availability.
  **ResourceLoader** loads extensions and resources, which can change the
  available capabilities. [SDK][native-sdk], [session format][native-format].

Programs can embed the public SDK or launch Pi's CLI, JSON mode or RPC mode.
OAR embeds the **in-process `@earendil-works/pi-coding-agent` SDK**: it
creates services and one `AgentSession`, not the replacement-oriented
`AgentSessionRuntime`. [SDK][native-sdk], [package overview][native-overview].

## High-level mapping to OAR

| Native concept or interface | Current OAR mapping |
|---|---|
| In-process AgentSession | One OAR Session wrapping the SDK object; no runtime subprocess. |
| Session file header ID | `Session.id`; resume resolves it to a file in the cwd's session directory. Every open starts a new record stream at seq 0; history is not rebuilt. |
| Agent run | One OAR turn: from the `prompt` request (accepted once pi emits `agent_start`) to pi's `agent_settled`, whose `turn_ended` event carries the outcome. Several native `turn_start`/`turn_end` pairs, threshold compaction and auto-retries sit inside it. |
| History tree and replacement APIs | Resume is mapped; branch navigation, fork, import and history access are not exposed. |
| ModelRuntime and ResourceLoader | Native services determine models/resources; OAR exposes selected startup options and catalog results. The `pi/session_opened` frame reports the effective model and thinking level as `model` and `effort` events. Outside sessions, `createPiProviderAuth` wraps `ModelRuntime.login`/`logout`/auth status and `createPiModelCatalog` wraps `ModelRegistry` (providers, model metadata, refresh). |
| SDK event stream | Every `AgentSessionEvent` is exactly one Frame record, verbatim as `native`, with the events OAR reads from it ([table](#observation-history-and-children)). No `spanId` (pi has no native turn id); `agentPath` is always root; capabilities declare `attribution: "none"`. |
| Control | `prompt`/`steer`/`queue`/`withdraw`/`abort`/`dispose` are request records answered accepted/rejected ([details](#prompt-steering-queueing-and-abort)). |
| Provider HTTP | The adapter sets undici's global dispatcher to an `EnvHttpProxyAgent`: the proxy half of what every pi entry point installs, without pi's global fetch replacement ([details](#http-plane-and-proxies)). |

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
`cwd`, `agentDir`, `sessionDir` and `filePath`, OAR uses this entry shape:

```ts
const services = await createAgentSessionServices({ cwd, agentDir });
const sessionManager = SessionManager.open(filePath, sessionDir);
const { session, modelFallbackMessage } = await createAgentSessionFromServices({
  services, sessionManager,
});
```

New sessions use `SessionManager.create(cwd, sessionDir)`. The simpler
`createAgentSession({ cwd, sessionManager })` is also public; the services
path loads extension provider registrations before resolving models.
Construction returns an `AgentSession`, not a completed run.
[SDK][native-sdk], [services source][native-services-source].

**Mapped:** OAR adds ID lookup through
`await piSession(installation, { cwd, resume: sessionId })`. The session
directory is pi's per-cwd formula, `<agentDir>/sessions/--<cwd slug>--`,
mirrored so the agent-dir pin and pi's own CLI land sessions in the same
place. The adapter calls `SessionManager.list(cwd, sessionDir)`, matches the
native header ID and opens that path. Search is scoped to that cwd and agent
directory: a session started elsewhere is not found, and the error names the
directory searched ([resume in another directory](resume-cwd.md)). A missing
match throws; pi writes the file on the first
message, so a session that never received one has no file. Live, resume by
header id finds the file, keeps the id and recalls the earlier transcript
(`resume` scenario; also [`session-resume.ts`](../../experiments/README.md)).
The directory formula, lookup and error are pinned by
[`tests/pi/pi-session-resume.test.ts`](../../tests/pi/pi-session-resume.test.ts).
[Resolver](../../packages/oar/src/runtimes/pi/resolve.ts).

**Extension lifecycle (SDK 1.0.4):** every OAR session, new or resumed,
awaits `session.bindExtensions({})` after construction and option readback,
before returning it to the host. Pi emits `{ type: "session_start", reason:
"startup" }` from that call and awaits extension resource discovery. This
matches CLI startup, including `--resume` and `--continue`: `dist/main.js`
selects the session manager but passes no `sessionStartEvent` to the initial
runtime; `dist/core/agent-session.js` defaults it to `startup`. The native
`new` / `resume` reasons belong to in-process session replacement through
`AgentSessionRuntime`, which OAR does not expose. No previous-session file
is supplied for startup.

On dispose, OAR first settles an active turn with Pi's abort, then awaits
`{ type: "session_shutdown", reason: "quit" }` before calling native
`session.dispose()`, while extension APIs are still usable. Unlike
`AgentSessionRuntime.dispose()` in Pi 1.0.4, which waits indefinitely, OAR
allows **10 seconds total** for the shutdown hooks. After that it releases
the native session and completes dispose normally. Node emits warning code
`OAR_PI_SHUTDOWN_TIMEOUT`, naming the session ID, `session_shutdown` and the
10000 ms limit; hosts can capture Node's `warning` event, and Node prints it
to stderr by default. Pi's public runner does not identify the currently
executing extension, so the warning does not attribute the timeout to a
particular extension. The deadline stops waiting and invalidates the native
session context; it cannot cancel arbitrary in-process extension code.

Repeated disposal does not emit the event again. A failure while binding
also uses this bounded shutdown before native disposal. This lifecycle applies with or without
`mcpServers`; MCP connections are one consumer, alongside user extensions.
These are native extension hooks, not `AgentSessionEvent` stream frames;
OAR does not synthesize lifecycle records.

The [lifecycle vendor test](../../sea-trial/vendor/pi-extension-lifecycle.vendor.test.ts)
loads a real user extension that asynchronously appends a session entry and
records both hooks. It covers new sessions and same-ID resumes with and
without MCP, checks the event payloads before open/dispose resolve, and
checks repeated disposal does not duplicate shutdown. The
[shutdown deadline vendor test](../../sea-trial/vendor/pi-extension-shutdown.vendor.test.ts)
loads a user extension whose shutdown hook never settles, then verifies
that native disposal runs, the diagnostic names the hook and timeout, and
OAR acknowledges dispose after the 10-second limit.

Native construction restores active-branch context, the saved model when
available, and the thinking level subject to current model capabilities. An
explicit OAR `model` overrides the saved one and is checked by readback;
without one the recorded model is restored, and the resumed stream starts with
only the `pi/session_opened` frame, whose `model` event carries the model from
the file. Native restoration can fall back when the saved model is
unavailable; OAR discards the returned `modelFallbackMessage`.
[SDK construction][native-sdk-source].

Reopening creates a fresh record stream (seq 0), fresh observers and an empty
adapter queue. It resumes the conversation, not interrupted execution or
historical event delivery: after a death, replay comes from the host's own
persisted records ([cursor](../spec/session-graph-and-cursor.md)). Native `session.messages`, tree navigation, fork and
import are **not exposed**. Corrupt-file handling and concurrent writers are
**unverified**. What a crash in the middle of a tool call leaves for a resume
is measured in [crash and resume](crash-resume.md) (SDK 0.99.2).
[Adapter](../../packages/oar/src/runtimes/pi/session.ts),
[kernel](../../packages/oar/src/shared/session-kernel.ts).

### Prompt, steering, queueing, and abort

**Prompt (mapped):** `prompt()` records a request and calls
`AgentSession.prompt(text)`. The response is `accepted` once pi emits
`agent_start`, or `rejected` (`runtime_refused`, with pi's own message) when
the promise rejects first (e.g. "Cannot submit a prompt while compaction is in
progress"). The turn ends at pi's `agent_settled`, whose `turn_ended` event
carries completed, aborted or failed. `agent_end` is recorded but does not end
the turn: pi runs threshold compaction and auto-retries between `agent_end`
and `agent_settled` and refuses prompts meanwhile (pinned with the pi-aimock
compaction recipe in the [vendor test](../../sea-trial/vendor/pi.vendor.test.ts)).
Provider failure can arrive in SDK events even when the prompt promise
resolves (a 400 surfaces only as `stopReason: "error"` on the turn's final
assistant message and the `message_update` error frame), so the projection
carries error state into the outcome. A run pi fails after starting, without
its own settlement, is recorded as a `pi/prompt_rejected` frame carrying pi's
message and a failed `turn_ended` event: pi's word, not a synthesized
boundary. A second prompt during a run is `rejected` `busy`
(`busy-and-late-control` scenario). Native prompt preflight callbacks are
**not exposed**.

**Images (mapped):** `InputOptions.images` become pi's `ImageContent`
(`{ type: "image", data, mimeType }`) for `prompt(text, { images })`,
`steer(text, images)` and held queue input. Pi sends them to a model whose
`input` lists `image` and drops them for a text-only one
([vendor test](../../sea-trial/vendor/images.vendor.test.ts), with an
image-capable aimock model; live with this machine's default model,
2026-09-29: a plain green PNG named `probe.png` was answered `green`).
[SDK][native-sdk], [projection](../../packages/oar/src/runtimes/pi/projection.ts).

**Steer (partial, landing observed):** `steer()` delegates to
`AgentSession.steer()` and answers `accepted` on queue entry, or `rejected`
(`no_active_turn`, reason `not_steerable: no active turn`) when no run is
active. Acceptance means entry
into pi's queue, not model receipt. Natively the steer is a `queue_update`
with the text under `steering`, inside the running span; the run's next
internal turn drains it (a `queue_update` with empty lists) and injects it as
a user message, so the text lands in the same turn's final reply with one
`turn_ended` (`steer` scenario: the final text combined the prompt's and the
steer's words).

**Queue (partial):** `queue()` uses an adapter FIFO
(`capabilities.queue.durable: false`), because native `followUp()` continues
the same outer run and would break OAR's separate-turn promise. The FIFO
drains one input per run end; a drained input runs as a spontaneous turn
(`agent_settled`, then `agent_start` with no request record of its own) and
its reply ends its own turn (`queue` scenario). If pi refuses a drained input,
the refusal is recorded as a `pi/prompt_rejected` frame with no events.
Native extension commands cannot simply be queued like ordinary text.
`withdraw(inputId)` takes an input out of the FIFO before the drain prompts
it (`accepted`) and answers `not_queued` after; pi's own `clearQueue()` is a
different queue and is not used ([input cancellation](input-cancellation.md),
[test](../../tests/pi/pi-session-withdraw.test.ts)).
[Agent loop][native-agent-loop], [SDK][native-sdk],
[adapter](../../packages/oar/src/runtimes/pi/session.ts).

**Abort (mapped, cooperative):** `abort()` makes pi's two public synchronous
calls, `AgentSession.abortRetry()` then `AgentSession.agent.abort()`, exactly
what pi's own `AgentSession.abort()` does before it awaits idle. Both are
no-ops until pi has created the run, so an abort taken before `agent_start`
is held and delivered there. The answer is `accepted` at delivery, ahead of
the turn end (awaiting idle would put it behind `agent_settled`), so callers
`awaitTurnEnd` before the next prompt, or the prompt is `rejected` `busy`
while pi is still settling. On abort the running tool ends with result text
`Command aborted`, pi still starts the next internal turn, whose assistant
message arrives with `stopReason: "error"` / `errorMessage: "This operation
was aborted"`, then `agent_end`, then `agent_settled`. The projection's abort
intent outranks that error, so `turn_ended` is `aborted`, not `failed`. A late
abort is `rejected` `no active turn`. The ordering (`request:abort`,
`response:accepted`, `tool_call_ended`, `turn_ended:aborted`) is pinned by the
[vendor test](../../sea-trial/vendor/pi.vendor.test.ts) and observed live
(`abort` scenario); the classification by the
[replay test](../../tests/replay/pi-projection.test.ts).

**Dispose:** `dispose()` records the request, clears the held queue, aborts
active work (this time awaiting pi's idle), disposes the SDK session, and
answers `accepted` after pi's aborted `agent_settled`. Mid-run the stream
reads `dispose`, pi's `Command aborted` tool end, the aborted `agent_settled`,
then `accepted` (`dispose-mid-turn` scenario). Pi runs in-process, so there is
no process exit to record. Afterwards every control, `abort` included, is
`rejected` `disposed` (`session disposed`).
[Adapter](../../packages/oar/src/runtimes/pi/session.ts),
[kernel](../../packages/oar/src/shared/session-kernel.ts).

### Observation, history, and children

**Mapped:** every SDK event is one Frame record with the event object as
`native`; nothing is dropped, and the exhaustive projection switch makes a
new pi event type a compile error.

| Pi SDK event | OAR events |
|---|---|
| `message_update` text / thinking deltas | `text_delta`; `reasoning` (`empty` for a thinking block with no text) |
| `message_start` of a user message | `user_message` (`evidence: "conversation"`; see [input identity](#user-input-identity-and-observation)) |
| `message_end` of an assistant message | cumulative token `usage` from its usage |
| `tool_execution_start` | `tool_call_started`, input = pi's `args` as JSON |
| `tool_execution_update` | `tool_call_progress`, `output` = the partial result as JSON |
| `tool_execution_end` | `tool_call_ended` (below) |
| `compaction_start` | `compaction_started`, `trigger` = pi's reason (`manual` / `threshold` / `overflow`) |
| `compaction_end` | `compaction_ended`: `aborted` → aborted, an `errorMessage` → failed with that reason, else completed; `willRetry` stays in `native` and the retry announces itself |
| `auto_retry_start`, `summarization_retry_scheduled` | `retry` with `attempt`, `maxAttempts`, `delayMs`, and the error message as `reason` [src 0.84.2 types] |
| `thinking_level_changed` | `effort` |
| `agent_settled` | `turn_ended`, plus a context `usage` event |

Agent and turn boundaries, assistant `message_start`, queue, entry,
session-info, bash execution and the other retry events are in the stream
with no event.

`tool_call_ended.content` is the blocks of pi's `result` in order (an image
block is an image part; a result without blocks is one `other` part); `details` such as an edit's `patch` stay in `native`; pi
reports no exit status, so `exitCode` is absent. `result` comes from pi's
explicit `isError` boolean ([src] `@earendil-works/pi-coding-agent` 0.84.2
`core/extensions/types.d.ts:595-600`): false is `"ok"`, true is `"failed"`,
absent only when the runtime omits it.

Live shape on the baseline model: a one-shot turn is 17 records, seq dense,
events `model`, `reasoning`, `text_delta`, `usage`, `turn_ended`, no `spanId`
(`basic` scenario). `gpt-5.3-codex-spark` streams
`thinking_start`/`thinking_end` with no deltas, so its reasoning event is
`reasoning` `empty`, never text. Tool input looks like
`{"command":"echo …"}`, the callIds match, and pi's callId for this provider
is the codex Responses pair `call_…|fc_…` (`tool-detail` scenario). The fold
over a recorded tool round is pinned by the
[replay test](../../tests/replay/pi-projection.test.ts); the tool framing by
the [vendor test](../../sea-trial/vendor/pi.vendor.test.ts).
[Projection](../../packages/oar/src/runtimes/pi/projection.ts).

Native history includes branch/compaction records and extension data that this
stream cannot reconstruct after a reopen. `rawEvents()` with a cursor replays
what this process retained and continues live, contiguous with the retained
log; a from-start replay equals `records()` (`cursor` scenario). It is not a
history API. The [Pi recorder](../../sea-trial/record/pi.ts) captures SDK
events for the replay fixture. [Session format][native-format].

Subagents and MCP integration can be implemented through extensions/tools.
That does not establish a universal built-in child protocol. OAR exposes no
child graph or child control handles; its only MCP configuration is the
session's own servers, through pi's MCP extension
([session MCP servers](#session-mcp-servers)). Other extension behavior
through the adapter remains **unverified**.
[Package overview][native-overview].

### Models, instructions, and context

**Mapped:** initial/resume `provider/model` selection uses the
extension-aware ModelRuntime. `Session.model()` folds the `model` event of
the `pi/session_opened` frame, which carries `AgentSession.model` as the SDK
reported it at open (pi exposes no later model-change event to OAR). The
adapter checks the spelling before pi is asked: a bare
`oar-no-such-model-xyz` fails the `provider/model` check, while
`openai-codex/oar-no-such-model-xyz` or `no-such-provider/gpt-5.3-codex-spark`
finds nothing through `ModelRuntime.getModel` and throws "is not registered":
no session, no tokens (`bad-model` scenario;
[`tests/pi/pi-session-resume.test.ts`](../../tests/pi/pi-session-resume.test.ts),
[`tests/pi/pi-session-model.test.ts`](../../tests/pi/pi-session-model.test.ts),
[resolver](../../packages/oar/src/runtimes/pi/resolve.ts)). Catalog discovery
(`oar models pi`) builds services the way `pi --list-models` does and awaits
`getAvailable()` instead of reading an uninitialized snapshot; "nothing
configured" is an `ok` empty list. Live model setters and detailed model
metadata are **not exposed** on the session (`createPiModelCatalog` reads
metadata outside it).

**Effort (mapped):** `SessionOptions.effort` is pi's thinking level, the
creation-time `thinkingLevel` of `createAgentSessionFromServices`, spelled in
pi's levels (`off, minimal, low, medium, high, xhigh, max`). Another word is
refused before pi sees it, because pi's `clampThinkingLevel` would silently
turn it into the model's lowest level (pi-ai 0.84.2 models.js). An explicit
level wins over a resumed session's recorded level and the settings default.
Pi clamps it to the model's menu: `getSupportedThinkingLevels` gives a model
without `reasoning` only `off`, drops levels `thinkingLevelMap` maps to null,
and adds `xhigh` / `max` only where mapped. The adapter reads
`AgentSession.thinkingLevel` back, and a clamp refuses the open (`pi runs
thinking level off for openrouter/deepseek/deepseek-chat although low was
requested (the model offers off)`). `AgentSession.setThinkingLevel` is not
used: it also writes the level into pi's global settings as the user's new
default. The `pi/session_opened` frame carries `thinkingLevel` as an `effort`
event.

The lister lists pi's per-model menu through pi-ai's
`getSupportedThinkingLevels` (a direct dependency, the function
`AgentSession.getAvailableThinkingLevels()` runs), `off` included where pi
offers it, with no `defaultEffort`: pi's default is a settings value
(`defaultThinkingLevel`, else `medium`) clamped per model, and `effort()`
reports it at open. On the wire (pi-aimock, anthropic-messages):
`thinking: {type: "enabled", budget_tokens: 2048}` for `low`, `15360` for
`high` ([vendor test](../../sea-trial/vendor/effort.vendor.test.ts)).

Resume quirk: pi records the level in the session file only for a new
session, or a resumed one whose file has none yet. A resume with an explicit
level runs it but leaves the recorded level, so a later resume that asks for
none restores the recorded one (live 2026-09-29: opened at `low`, resumed at
`medium`, then a plain resume reported `low`). Live thinking changes are
**not exposed** ([native surfaces](live-configure.md)).
[Opener](../../packages/oar/src/runtimes/pi/open.ts),
[unit test](../../tests/pi/pi-session-effort.test.ts),
[lister](../../packages/oar/src/runtimes/pi/list-models.ts),
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

**Context (mapped):** the `agent_settled` frame carries a `usage` event with
native `getContextUsage()` read at that moment (post-compaction; tokens null
when unknown), so `Session.contextUsage()` (a fold) is current at turn end.
`usage()` is the cumulative per-session total; its input counts pi's
`input + cacheRead + cacheWrite`, and pi's `cacheRead` and `cacheWrite`
accumulate as the total's own `cacheRead` and `cacheWrite` (`cacheWrite1h`, a
subset of `cacheWrite`, is not added again;
[spec](../spec/attribution.md#cache-reads-and-writes)). Live on the baseline model: a one-shot turn
`{input: 1381, output: 39}` with `contextUsage().value` `{tokens: 1420,
contextWindow: 128000}`; three turns 1377 → 2772 → 4186 input, one
`turn_ended` per prompt (`basic`/`multi-turn` scenarios). The compaction
events are pinned with the pi-aimock recipe (tiny `contextWindow` plus fat
reported usage plus compaction settings) and have not been reached with a
real provider: live contexts stay near 1.4k of 128k tokens. Explicit
compact/abort-compaction controls are **not exposed**.
[Native compaction][native-compaction],
[adapter](../../packages/oar/src/runtimes/pi/session.ts),
[vendor test](../../sea-trial/vendor/pi.vendor.test.ts).

### Tools, permissions, extensions, and environment

**Partial:** `createAgentSessionServices` loads native resources and extension
provider registrations. OAR offers no general tool registration/allowlist or
extension callback interface; its custom bash tool exists to overlay
environment variables. Extensions make effective capabilities
configuration-dependent.

OAR pre-trusts cwd in native `trust.json`, an observable persistent write.
Extensions can still implement permission gates and interactive flows; OAR has
no general approval/user-input bridge for them. `SessionOptions.env` affects
subprocesses spawned by the replacement bash tool and the session's stdio
MCP servers ([below](#session-mcp-servers)), not provider keys/base
URLs. A `null` entry removes an inherited variable from Bash children,
without changing the host environment. Pi refuses removals combined with
stdio MCP servers: see below and the
[environment contract](../spec/runtime-matrix.md#session-environment).
Provider configuration uses native model/agent-dir channels;
`OAR_PI_AGENT_DIR` is process-level.
[Opener](../../packages/oar/src/runtimes/pi/open.ts),
[native extensions][native-extensions].

### Session MCP servers

`SessionOptions.mcpServers` uses pi's own MCP support as the pi CLI runs it
([mapping](../../packages/oar/src/runtimes/pi/mcp.ts),
[test](../../tests/pi/pi-mcp-servers.test.ts)): the built-in MCP extension
(`createMcpExtension`, on `@earendil-works/pi-mcp`), which the CLI loads by
default and the SDK path OAR opens does not, plus one inline extension calling
`pi.registerMcpServer(name, config)` ("Register an MCP server for this
session, with the same config as an mcpServers entry",
`core/extensions/types.d.ts`). Unlike wrapping pi-mcp's client as custom
tools, this keeps pi's own tool naming, result rendering, reconnects and
lifecycle, and adds no dependency. Measured on the bundled pi-coding-agent
1.0.4 against a scripted provider
([vendor test](../../sea-trial/vendor/mcp-servers-pi.vendor.test.ts),
[recording](../../tests/replay/fixtures/pi-mcp-echo.raw.jsonl)):

- Both transports attach and each tool is declared to the model directly as
  `mcp__<server>__<tool>` (`exposure: "direct"`; pi's default, `codemode`,
  needs the codemode extension, which OAR does not load). The tool result
  reached the provider as the server wrote it, so the server ran with the
  entry's `env` (stdio) or `headers` (http).
- The MCP extension connects on `session_start` and closes on
  `session_shutdown`, the [lifecycle OAR drives for every Pi session](#session-creation-and-resume),
  including sessions without MCP. The stdio servers exit on shutdown.
  The first prompt waits up to 10 s for the servers.
- A resume remembers none: OAR registers them again on every open; resumed
  without the option, no `mcp__` tool is offered.
- OAR loads the MCP extension with no `mcp.json` of its own (`loadConfig`
  returns nothing); OAR's pi never loaded the user's `mcp.json` (the SDK path
  loads no built-in extensions), with or without this option. In pi an
  `mcp.json` server would win a clash; here, with `echo` and `userecho` in
  the agent dir's `mcp.json`, the session's `echo` answered and `userecho`
  was not offered.
- pi takes names matching `^[A-Za-z0-9_-]+$` and folds `-` into `_` for the
  tool namespace, so OAR refuses any other name, and two names pi would fold
  together, with a plain error before opening. A name another extension (the
  user's) already registered fails the open ("pi did not register the
  session's MCP servers: ... already registered") rather than run without
  the server.
- pi resolves `env` and header values (`!cmd` runs a shell command, `$NAME`
  and `${NAME}` interpolate); OAR escapes every `$` and `!` (`$$`, `$!`) so
  each value reaches the server literally (the unit test round-trips pi's
  resolver). pi expands a leading `~` in `command` and `args`.
- A stdio server gets the host's environment, then `SessionOptions.env`, then
  the entry's `env` (pi-mcp's `StdioTransport` inherits `process.env`).
  Pi 1.0.4's MCP registration only accepts string overrides, and its default
  transport re-inherits the host environment. An `env` removal combined with
  any stdio `mcpServers` therefore fails before opening with
  `UnsupportedOptionError` on `env`. No removed key or value is named in the
  error. Removals without stdio servers, including HTTP-only servers, still
  apply to Bash. A `null` inside a server's own `env` is always refused.

pi's MCP server log goes to `<agentDir>/mcp.log`. Nothing written under the
agent dir held a credential (measured: the session file; no `mcp.log` was
written), the
vendor test asserts no record holds one, and a registration failure's
message is redacted. The recording comes from
`pnpm sea-trial:record pi-aimock mcp-echo -`, system prompt messages
scrubbed.

### HTTP plane and proxies

Every pi entry point (`cli.js`, `rpc-entry.js`, `main.js`) calls its
`configureHttpDispatcher()` before a provider request: an undici
`EnvHttpProxyAgent` honoring `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (plus the
global `httpProxy` setting copied into the env, and pi's idle timeouts)
**and** `undici.install()`, which replaces `globalThis.fetch`/`Headers`/
`Request`/`Response`/`WebSocket`/`FormData` for the whole process. The public
SDK entry does neither. On Node's default dispatcher, which ignores proxy env,
an embedded pi behind `HTTPS_PROXY` fails every provider call through pi's own
auto-retry (`auto_retry_start` ×3, `auto_retry_end` `finalError: "fetch
failed"`, `agent_settled` → `failed`) while the `pi` CLI works.

**Mapped, narrowly:** the adapter does not call pi's module (unexported, and
its global-class replacement is no footprint for an embedding library). Before
a session, model listing, login or catalog reaches a provider, it sets
undici's global dispatcher itself to an `EnvHttpProxyAgent` built from the
settings manager those entry points read (`OAR_PI_AGENT_DIR ?? getAgentDir()`).
`undici` is a direct dependency of `@botiverse/oar`, pinned to the version pi
uses (8.10.2, one instance in the tree). An env proxy wins; pi's `httpProxy`
setting fills both http and https when the env names none (pi's own `??=`
precedence, but the env is not written); pi's `httpIdleTimeoutMs` setting is
the dispatcher's headers/body timeout (pi's default equals undici's). Nothing
is installed when neither a proxy nor a non-default timeout is configured, and
a global dispatcher the host already set is never replaced. Node's own `fetch`
reads the dispatcher through `Symbol.for("undici.globalDispatcher.1")`, so the
global fetch classes stay Node's. Compressed bodies decoded in the 2026-09-11
probe (Node 26.7, whose bundled undici 8.9.0 was then also the pin), and the
live battery reaches the provider through the plane from a host with
`HTTPS_PROXY` set. Not taken from pi's plane: `undici.install()`, the
`"error"` listener pi puts on every undici client, the `allowH2`/connect
tuning. When undici cannot be loaded, or the host's own dispatcher is kept,
the adapter emits one `OAR_PI_PROXY_PLANE` process warning and the session
runs on the existing dispatcher; a failed load is not cached, so a later
entry point retries. Precedence, proxying through a local stand-in, the
untouched env and the untouched global classes are pinned by
[`tests/pi/pi-http.test.ts`](../../tests/pi/pi-http.test.ts).
[HTTP plane](../../packages/oar/src/runtimes/pi/http.ts).

### Process ownership, installation, login, and account usage

The SDK shares its host process. Global configuration, lazy environment reads
and the global dispatcher mean the adapter cannot promise independently
configured embedded Pi runtimes within one process. Releasing a session is SDK
disposal, not killing a runtime subprocess. With no process to kill, no kill
fallback backs `abort()` (Claude, Codex and the ACP runtimes begin process
termination after ten seconds without a turn end).
[Adapter](../../packages/oar/src/runtimes/pi/session.ts).

**Mapped:** installation checks that the bundled SDK resolves or imports;
there is no executable to probe and no version to report. The SDK is a
regular dependency of OAR and moves with the OAR version, so Pi has no
`checkUpdate` or `upgrade` ([runtime updates](update.md)). Native providers
support API keys and OAuth; `createPiProviderAuth` exposes per-provider
status, interactive login (auth-URL / device-code / prompt events bridged from
pi's `AuthInteraction`), `setApiKey` and logout through `ModelRuntime`,
outside the session interface. OAR has **no accountUsage reader** for Pi: it
runs on provider credentials and has no subscription usage surface to
observe. An empty usable-model catalog does not establish a universal
unauthenticated state.
[Native providers][native-providers],
[installation](../../packages/oar/src/runtimes/pi/installation.ts),
[provider auth](../../packages/oar/src/runtimes/pi/auth.ts),
[runtime registration](../../packages/oar/src/runtimes/pi/index.ts).

### User input identity and observation

Input requests retain a logical `inputId`, including steer → queue fallback.
The [conversation contract](../spec/conversation.md) specifies native echo
mapping and the limits of acknowledgement evidence; the
[steer delivery probes](steer-delivery.md) record the underlying native
observations.

## Verification and open gaps

[`experiments/live-contract.ts pi`](../../experiments/live-contract.ts) runs
eleven scenarios on a real login (`basic`, `multi-turn`, `tool-detail`,
`busy-and-late-control`, `steer`, `queue`, `abort`, `dispose-mid-turn`,
`cursor`, `resume`, `bad-model`); `subagent` and `kill-runtime` are skipped
(no native sub-agents, in-process runtime). The other
[experiments](../../experiments/README.md) cover SDK import, catalog
(`pi-list-models.ts`), resume and model readback (`session-resume.ts`,
`session-model-readback.ts`), and cross-version resume
(`pi-upgrade-resume.ts`).
[Vendor tests](../../sea-trial/vendor/pi.vendor.test.ts) run the real SDK
with a scripted model (pi-aimock) for the 400 error edge, a two-round tool
conversation, prompt configuration through threshold compaction with
`compaction_*` in the stream, abort answered ahead of the aborted turn end,
and context at turn end with every SDK event one record;
[MCP vendor tests](../../sea-trial/vendor/mcp-servers-pi.vendor.test.ts)
cover [session MCP servers](#session-mcp-servers) and run in CI's pi-aimock
job. The
[replay test](../../tests/replay/pi-projection.test.ts) pins the fold over the
recorded tool-round fixture and the settled/abort/error classification; the
unit tests under [`tests/pi/`](../../tests/pi/) pin the session-directory
formula, id lookup, model spelling/resolution, model readback, tool result
text and the HTTP plane.

Open gaps: accepted steering through retry/compaction; distinct queued turns
under races; extension-generated activity (children, permission gates,
commands); unavailable saved-model fallback on resume; threshold compaction
with a real provider; session MCP servers on a real login and model
(measured against a scripted provider only); and corrupt session files and
concurrent writers.

[native-sdk]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md
[native-format]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/session-format.md
[native-compaction]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/compaction.md
[native-extensions]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/extensions.md
[native-providers]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/providers.md
[native-overview]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/README.md
[native-agent-loop]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/agent/src/agent-loop.ts
[native-services-source]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/agent-session-services.ts
[native-sdk-source]: https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/src/core/sdk.ts

## Disallowed tools

`SessionOptions.disallowedTools` goes to `createAgentSessionFromServices`
as `excludeTools` on both new and resumed sessions. The SDK filters its own
registry, including OAR's environment-aware Bash replacement and tools
registered later by extensions/MCP. Use Pi names such as `bash`, `read` and
`mcp__server__tool`; native pattern matching is unchanged. OAR does not edit
Pi's settings or build an allowlist. Supply the list again on resume.

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).
