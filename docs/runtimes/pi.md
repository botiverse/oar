# Pi

Independent inventories: resource-loader skills, registered tools with
parameter schemas and active membership, plus extension commands and prompt
templates (SDK 1.1.0, 2026-10-11). Core MCP discovery is unsupported. See the
[query contract](../spec/inventory.md) and
[native probe evidence](inventory.md).

Evidence baseline: OAR source as of 2026-09-11; bundled
`@earendil-works/pi-coding-agent` SDK **1.4.0**, with `@earendil-works/pi-ai`;
OAR depends on both at `^1.4.0`. Native source references are pinned to pi
**v0.84.2** (commit prefix `914cf1472`; former `badlogic/pi-mono` URLs
redirect to `earendil-works/pi`). Live observations below are from SDK
**0.84.2** unless they name a version or date (the bundled SDK moved to 0.87.1
on 2026-09-29, 0.99.1 on 2026-09-30, 0.99.2 on 2026-10-01, 1.0.0 on
2026-10-02, 1.0.2 on 2026-10-04, 1.0.3 on 2026-10-05, 1.0.4 on 2026-10-06,
1.1.0 on 2026-10-08, 1.2.0 on 2026-10-13, 1.3.0 on 2026-10-16 and 1.4.0 on
2026-10-22): in-process
runs of [`experiments/live-contract.ts pi`](../../experiments/live-contract.ts)
and the [experiments index](../../experiments/README.md) probes against
`openai-codex/gpt-5.3-codex-spark` (codex OAuth through pi; every assistant
frame carries `provider: "openai-codex"`, `api: "openai-codex-responses"`) on
Node 26.7 / macOS. Versions are evidence baselines, not a support range; see
the [runtime index](README.md) for conventions.

**Upgrade checks.** The newest live runs are on SDK 1.0.0, 1.0.2, 1.0.3 and
1.0.4 (2026-10-02 to 10-06; Linux x64, Node 24.19.0,
`exe-dev-openai/gpt-6-luna@llm`): each time all 11 applicable live cases
passed (subagents and process killing inapplicable; on 1.0.4 `tool-detail`
passed on a targeted retry after an upstream overload response), and so did
the eight applicable vendor tests and the 19-case simulated-provider behavior
suite (withdrawal included; only inapplicable cases skipped). 1.1.0 through
1.4.0 were checked against local scripted providers only; on 1.4.0, 63
native tests and the shared behavior suite (17 passed, 2 skipped) cover
native controls, extension lifecycle and tool handling. At every upgrade
from 0.99.2 to 1.0.0 through 1.3.0 to 1.4.0, a separate-process probe
([`pi-upgrade-resume.ts`](../../experiments/pi-upgrade-resume.ts)) resumed a
session created by the previous SDK: native id, saved model and prior
transcript survived, and the new OAR stream started at sequence zero. This
checks conversation continuity, not unfinished execution recovery. None of
these upgrades adopts the separate experimental [Pi Durable](pi-durable.md)
harness. Scope, commands and evidence: version check reports of
[October 2](../../experiments/runtime-version-checks/2026-10-02.md),
[4](../../experiments/runtime-version-checks/2026-10-04.md),
[5](../../experiments/runtime-version-checks/2026-10-05.md),
[6](../../experiments/runtime-version-checks/2026-10-06.md),
[8](../../experiments/runtime-version-checks/2026-10-08.md),
[13](../../experiments/runtime-version-checks/2026-10-13.md),
[16](../../experiments/runtime-version-checks/2026-10-16.md) and
[22](../../experiments/runtime-version-checks/2026-10-22.md).

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

**Extension `before_agent_start` since 1.2.0:** it also runs for custom
messages that trigger turns, discriminated by `messageType`: a
custom-message turn carries `message` rather than `prompt`/`images`.
Extensions using it must follow that distinction; OAR leaves that extension
API native.

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
OAR defaults to the **in-process `@earendil-works/pi-coding-agent` SDK**: it
creates services and one `AgentSession`, not the replacement-oriented
`AgentSessionRuntime`. Hosts can instead select one native RPC process per
session with `createPiRuntime({ execution: "subprocess" })`, described below. [SDK][native-sdk], [package overview][native-overview].

## Optional native RPC process

```ts
import { createPiRuntime } from "@botiverse/oar";

const pi = createPiRuntime({ execution: "subprocess" });
// A packaged host can instead delegate to its own Pi subcommand:
const packagedPi = createPiRuntime({
  execution: "subprocess",
  command: "/path/to/host",
  args: ["pi"],
});
```

The default remains in-process. The subprocess selection launches the current
Node executable with Pi's exported `@earendil-works/pi-coding-agent/rpc-entry`,
not a second OAR SDK host. An explicit `command` is one executable path or PATH
name; `args` are literal prefix arguments, not shell text. The selected command
must implement Pi's `--version` and `--mode rpc` CLI behavior. It is checked at
each open against OAR's installed Pi dependency version before extensions or a
session start. The session's own extension reports its version again. A missing
or different version fails explicitly; OAR does not adapt between RPC versions.
A single-file host without a separate Node executable must provide a command.

With a normal package tree OAR reads the dependency's package metadata directly.
For a bundled host it uses Pi's source `PI_AI_VERSION` constant; the test suite
checks that it equals the coding-agent package version in OAR's build. The
coding-agent `VERSION` export alone cannot identify the host's dependency:
`PI_PACKAGE_DIR` can make it read the embedding application's package metadata.
This variable still belongs to native Pi configuration; an inherited override
that makes the selected executable report a different version is rejected.

RPC commands are newline-delimited JSON with correlated ids. OAR opens with
`get_state`, reads the effective native model and thinking level, and shares the
SDK event fold. Each native event and RPC response remains a frame in receive
order. After every `agent_settled`, `get_session_stats.contextUsage` supplies the
context usage event before the completed turn becomes visible. In Pi 1.4.0 the
fields are `tokens`, `contextWindow`, and `percent`; tokens and percent may be
null after compaction, and the entire value may be absent without a model.
OAR does not derive context usage from cumulative token totals. A failed stats
query does not invent usage or erase the native turn boundary.

Both locations use cwd-scoped session-id lookup and resume by full file path.
The native child records the physical cwd after resolving directory symlinks.
Lookup accepts that spelling as well as the supplied cwd within the same
session directory, so macOS `/var` aliases and linked project directories can
resume without moving their files or searching other projects.
Model and thinking are read back after startup; name and system prompts use
native startup flags. These options do not rewrite global defaults.

System and appended prompt text travels in separate files inside the private
session directory, with 0600 file permissions and a 0700 directory on POSIX.
Only the file paths appear in the process arguments, so long multiline prompts
do not consume the Windows command-line limit. Pi 1.4.0's `resolvePromptInput`
reads an existing path, but treats a missing or unreadable path as literal
prompt text; a read error only emits a warning. OAR therefore reads each file
back before starting the session process and explicitly fails if that read
fails or differs from the requested text. Files remain until the child exits
or is disposed, and startup failures remove the private directory as well.

`prompt` uses native `started`/`queued`/`handled`
acknowledgments. A handled command can be accepted without creating a turn.
Steering is native; queued inputs remain in OAR until sent, preserving individual
withdrawal instead of using native `clear_queue` (which clears everything).

The same factory object accepts `execution`, `command`, `args`,
`projectTrusted`, and `allowProjectPackageInstall`. The subprocess uses native
`--approve` by default and `--no-approve` for `projectTrusted: false`. These are
per-process overrides, not persistent trust grants. Like the SDK path, opening
a cwd with the default trust can execute its Pi extensions. Package installation
requires the explicit policy described below. The child receives the
session environment, including removals, so provider variables and MCP children
are isolated from the host. This is broader than the SDK's bash/MCP-only env
overlay. OAR passes `--no-mcp` and supplies session MCP servers through a small
native extension, materialized from bundled source into a private directory.
Its configuration uses a private file (0600 on POSIX), never command-line
arguments. Discovered provider keys travel only in a separate bidirectional
stdio pipe at fd 3. The extension waits for the parent to register each key for
redaction before continuing startup or a model change; keys never enter OAR's
private files or RPC stdout. These pipe and model-switch checks run on Linux,
macOS and Windows. The child uses Pi's own
`registerMcpServer`; collisions with user registrations still fail natively.
Neither location exposes arbitrary inline extension factories or custom tools.
Unsupported session options remain typed refusals; RPC additionally refuses
`launchArgs` so startup flags cannot contradict checked options.

Resume differences are explicit:

- **Builtins reset in both locations.** Before user `session_start` handlers,
  RPC restores the current native defaultTools (or Pi's built-in default set),
  intersected with registered builtins. Current `disallowedTools` removes tools
  before registration and always wins over historical activation. User extension
  handlers can still change the active set, as on a fresh session.
- **Extension defaults differ.** Native RPC can restore a previously activated
  extension tool whose `defaultActive` is false. SDK mode resets to the current
  defaults. Pi's public RPC/extension metadata does not expose `defaultActive`,
  so OAR cannot safely reset extension defaults without activating tools that
  should remain inactive.
- **Pending history differs.** With no active tool available, Pi's public
  `setActiveTools([])` does not clear restored unresolved names. RPC keeps the
  native pending list; a later registration can activate such a name. SDK mode
  refuses this unresolved case when it cannot clear it safely. Current explicit
  exclusions still block the tool in RPC. These locations are not equivalent
  for extension-tool restoration.

Dispose closes stdin first, letting native EOF run extension shutdown hooks.
The shared process owner then bounds the wait by `OAR_KILL_GRACE_MS` and kills
remaining descendants, including detached ones captured when disposal began.
Abort has the same bounded process fallback as other process runtimes. Native
crashes produce the actual process exit; they do not fabricate a turn end.
Interactive extension requests remain native app requests; OAR cancels dialogs
that require a reply rather than hanging without a host UI bridge.

The ordinary `installation`, model catalog and inventory members still inspect
OAR's bundled Pi. The selected process command is validated at session open.
Provider login and account APIs remain outside the session interface.

Evidence: [native RPC probe](../../experiments/pi-rpc-native/README.md),
[process-boundary tests](../../sea-trial/vendor/pi-rpc.vendor.test.ts),
[private prompt-file tests](../../sea-trial/vendor/pi-rpc-prompt-files.vendor.test.ts),
[single-file host test](../../sea-trial/vendor/pi-rpc-bundled.vendor.test.ts),
and the same portable Pi vendor and shared behavior suites for `pi-aimock` and
`pi-rpc-aimock`. SDK-object-specific tests stay on the SDK path. The following
sections describe the default SDK path unless the RPC differences above apply.

## High-level mapping to OAR

| Native concept or interface | Current OAR mapping |
|---|---|
| In-process AgentSession | One OAR Session wrapping the SDK object; no runtime subprocess. |
| Session file header ID | `Session.id`; resume resolves it to a file in the cwd's session directory. Every open starts a new record stream at seq 0; history is not rebuilt. |
| Agent run | One OAR turn: from the `prompt` request (accepted once pi emits `agent_start`) to pi's `agent_settled`, whose `turn_ended` event carries the outcome. Several native `turn_start`/`turn_end` pairs, threshold compaction and auto-retries sit inside it. |
| History tree and replacement APIs | Resume is mapped; branch navigation, fork, import and history access are not exposed. |
| ModelRuntime and ResourceLoader | Native services determine models/resources; OAR exposes selected startup options and catalog results. The `pi/session_opened` frame reports the effective model and thinking level as `model` and `effort` events. Outside sessions, `createPiProviderAuth` wraps `ModelRuntime.login`/`logout`/auth status and lists the providers pi's `/login` offers (`loginProviders`), and `createPiModelCatalog` wraps `ModelRegistry` (providers, model metadata, refresh). |
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

### Project trust and package installation

`createPiRuntime({ projectTrusted, allowProjectPackageInstall })` configures
both execution locations and the SDK-backed model-list and inventory entry points.
`piRuntime` uses the defaults below.

- `projectTrusted` defaults to `true`: choosing a cwd permits its native
  project settings and extensions to load. OAR passes this decision to
  `SettingsManager.create` for this operation and selects native `--approve`
  for RPC; neither writes `trust.json`. Pi 1.4.0 `cli/args.js` records that
  flag only as `projectTrustOverride`; `main.js` passes it to this runtime's
  settings manager and bypasses trust prompting and persistent decisions.
  The native tests verify that new trust files are not created and an existing
  file remains unchanged, with both trusted and untrusted operation.
- `projectTrusted: false` uses Pi's native untrusted-project mode. Project
  settings, package declarations and extensions are not loaded. User/global
  configuration and extensions still apply; this is not a sandbox.
- `allowProjectPackageInstall` defaults to `false`. OAR asks Pi's native
  package resolver whether its full configured package list needs installation,
  including replacement of an installed but incompatible version. If so,
  opening rejects with `RuntimeFailureError`, `failure: "invalid_request"`
  and `code: "project_packages_blocked"`, before loading extensions. This
  is not a missing session or a refusal of `cwd`. Start the host with native
  `PI_OFFLINE=1` or explicitly allow installation. Model listing and
  inventories report the refusal through their existing result shapes.
  Already-installed compatible packages open normally. Untrusted project
  declarations are absent from the native list, but user packages still apply.

The preflight uses `DefaultPackageManager.resolve(onMissing)` with Pi's
original settings. Its callback does not report package scope, so OAR
conservatively refuses any installation in the full native list, including
unrelated user packages. This can be stricter than a project-only policy;
the error lists all packages needing installation and gives both remedies.
OAR does not copy Pi's inheritance, deduplication or version-matching logic.
The preflight neither installs packages nor executes extensions and does
not write the host's settings or trust store.

For RPC, OAR runs that same preflight before probing or starting the child.
The SDK was already imported for native session-file lookup; this adds a
settings manager and metadata resolution, not services or extension loading
inside the host. Project policy also applies to the factory's model listing
and inventories, which remain SDK-backed in both execution modes. The
preflight's native offline exception is the host's `PI_OFFLINE` setting, just
as in process. Child environment overrides do not relax this host policy.

RPC additionally passes `--offline` unless installation is explicitly allowed.
This prevents the native loader from installing if another process changes
the package store after preflight. Missing or incompatible packages still
receive the same typed refusal first; OAR does not silently skip them just
because execution moved to a subprocess. Explicit host offline mode permits
native skipping in both paths, and explicit installation permission removes
the automatic flag without overriding a host or child `PI_OFFLINE` value.
Native offline mode also disables other Pi startup network operations; provider
requests still work. It is a startup option, not a sandbox for extension code.

Pi 1.4.0's in-process resource loader has no per-operation no-install setting.
Its offline switch reads the host process environment, which OAR never mutates.
The preflight checks the package store before loading; it does not lock the
store against concurrent changes or prevent extension code from doing its
own work. Use native offline mode when the loader must never install, even
if another process changes the store after the preflight. Pi accepts only
`1`, `true` and `yes`, case-insensitively, without trimming whitespace.
A missing path in offline mode emits `OAR_PI_PACKAGE_MISSING`; this warning
does not assert that an existing package satisfies its configured version.

Verified with Pi 1.4.0 using a local npm substitute, without a registry or
credentials and with no user packages configured:

| Project packages | Default | `PI_OFFLINE=1` | Explicitly allow installation |
| --- | --- | --- | --- |
| None | Opens | Opens | Opens |
| Installed compatible version | Loads | Loads | Loads |
| Missing | Typed refusal, no install | Opens without package | Installs and loads |
| Installed incompatible version | Typed refusal, no install | Opens without package | Replaces and loads |

Additional native tests cover inherited user packages, conservative refusal
of unrelated missing user packages, and `projectTrusted: false`: the latter
neither installs packages nor executes project extensions, and leaves an existing trust
file unchanged. The same package-policy matrix runs against SDK and RPC startup. [Policy tests](../../sea-trial/vendor/pi-project.vendor.test.ts),
[resolution tests](../../sea-trial/vendor/pi-project-resolution.vendor.test.ts).

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
match throws `SessionNotFoundError`, with the requested `sessionId` and
`cause: { method: "SessionManager.list", native: { cwd, sessionDir, sessionCount } }`.
This means not found for this cwd, not absent from every Pi directory; failed
list calls keep their original errors
([missing targets](../spec/runtime-matrix.md#missing-resume-targets)). Pi writes the file on the first
message, so a session that never received one has no file. Live, resume by
header id finds the file, keeps the id and recalls the earlier transcript
(`resume` scenario; also [`session-resume.ts`](../../experiments/README.md)).
The directory formula, lookup and error are pinned by
[`tests/pi/pi-session-resume.test.ts`](../../tests/pi/pi-session-resume.test.ts).
[Resolver](../../packages/oar/src/runtimes/pi/resolve.ts).

**Extension lifecycle (SDK 1.1.0):** every OAR session, new or resumed,
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
`AgentSessionRuntime.dispose()` in Pi 1.1.0, which waits indefinitely, OAR
allows **10 seconds total** for aborting an active run and the shutdown
hooks together. The SDK's `abort()` waits for idle without its own deadline,
so it is inside the same bound. After that OAR releases
the native session and completes dispose normally. Node emits warning code
`OAR_PI_SHUTDOWN_TIMEOUT`, naming the session ID, `session_shutdown` and the
10000 ms limit; hosts can capture Node's `warning` event, and Node prints it
to stderr by default. Pi's public runner does not identify the currently
executing extension, so the warning does not attribute the timeout to a
particular extension. If abort settles only after the deadline, OAR does
not start shutdown hooks on the disposed context. Forced cleanup does not
invent `agent_settled` or a successful turn outcome. The deadline stops waiting and invalidates the native
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

**Session name (mapped, [#368](https://github.com/botiverse/oar/issues/368)).**
`SessionOptions.name` is pi's session name: a `session_info` entry, written
on the session manager as pi's own `--name` writes it, so no extension sees
a rename event; pi's session list reports it. A new session gets it once the
open's checks pass; a resumed one only if it never had a `session_info`
entry, so a name the user gave, or cleared, stays. A blank name is refused
(`UnsupportedOptionError`) before the open, as pi's `--name` refuses one. [Vendor test](../../sea-trial/vendor/pi-session-name.vendor.test.ts).

### Interrupted input

Pi retains steering input across the tested abort. In SDK 1.0.4,
`pi-agent-core/dist/agent.js`'s `abort()` only signals the active run;
`finishRun()` does not clear the steering queue. The loop can drain steering
into the transcript while an aborted tool settles, before the next model
request. The local-provider probe observed the steering text in the next
prompt's provider request. OAR emits no `input_dropped` on Pi's aborted
`agent_settled`. Its echoes have no input IDs, so request-position placement
continues. [Evidence](../../experiments/input-interruption-2026-10-08.md).

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

Image-only input passes `""` as the SDK text argument, with the same images.
Pi SDK 1.0.4 emits an Anthropic image block and no text block for an
image-capable model, verified by the [image-only provider test](../../sea-trial/vendor/image-only.vendor.test.ts).
The SDK may still drop images for a model that does not declare image input.

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

**Abort (mapped, cooperative):** `abort()` invokes the public
`AgentSession.abort()` method without awaiting its idle wait. In SDK 1.1.0
that method synchronously marks the run aborted, cancels retry, compaction
and branch-summary work, and signals the agent before awaiting idle. OAR
records `accepted` immediately; acceptance is delivery of the cancellation,
not evidence that the turn has ended. Before Pi creates its run, OAR holds
the abort and delivers it at `agent_start`. Callers still `awaitTurnEnd`
before the next prompt. A late abort rejects with `no_active_turn`.

The outcome comes from **`agent_settled.aborted`** (authoritative since SDK
1.1.0), not from OAR's request state. A native `true` produces
`turn_ended: aborted` even if an extension called `ctx.abort()` and the host
never requested it. A native `false`
keeps a provider failure or normal completion. This also prevents a
provider's abort-related error message from changing a native cancellation
into failure. A later rejection from the SDK's abort promise is retained
as `pi/abort_rejected`, without synthesizing a turn boundary.

The [vendor test](../../sea-trial/vendor/pi.vendor.test.ts) pins
`request:abort`, `response:accepted`, then the native aborted settlement;
the [extension test](../../sea-trial/vendor/pi-native-abort.vendor.test.ts)
loads a real extension that cancels a tool call without any OAR abort
request. The [replay tests](../../tests/replay/pi-projection.test.ts) pin
classification, and the
[session test](../../tests/pi/pi-session-withdraw.test.ts) covers an abort
accepted before `agent_start`.

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
| `agent_start` | `turn_active`, including SDK-started runs without an OAR prompt; does not reopen an already running turn |
| `message_update` text / thinking deltas | `text_delta`; `reasoning` (`empty` for a thinking block with no text) |
| `message_start` of a user message | `user_message` (`evidence: "conversation"`; see [input identity](#user-input-identity-and-observation)) |
| `message_end` of an assistant message | cumulative token `usage` from its usage |
| `tool_execution_start` | `tool_call_started`, input = pi's `args` as JSON |
| `tool_execution_update` | `tool_call_progress`, `output` = the whole current partial result as JSON, replacing the earlier preview |
| `tool_execution_end` | `tool_call_ended` (below) |
| `compaction_start` | `compaction_started`, `trigger` = pi's reason (`manual` / `threshold` / `overflow`) |
| `compaction_end` | `compaction_ended`: `aborted` → aborted, an `errorMessage` → failed with that reason, else completed; `willRetry` stays in `native` and the retry announces itself |
| `auto_retry_start`, `summarization_retry_scheduled` | `retry` with `attempt`, `maxAttempts`, `delayMs`, and the error message as `reason` [src 0.84.2 types] |
| `thinking_level_changed` | `effort` |
| `agent_settled` | `turn_ended`, plus a context `usage` event |

Other agent and turn boundaries, assistant `message_start`, queue, entry,
session-info, bash execution and the other retry events are in the stream
with no event.

`tool_call_ended.content` is the blocks of pi's `result` in order (an image
block is an image part; a result without blocks is one `other` part); `details`
such as an edit's `patch` stay in `native`. CodingTools' numeric
`structuredContent.exit_code` becomes `exitCode`; otherwise it is absent.
Pi 1.3.0's local runner reports SIGTERM as 143 (128 + 15), which OAR preserves
([vendor test](../../sea-trial/vendor/pi-exit-code.vendor.test.ts),
[native exits](../../experiments/runtime-version-checks/2026-10-16.md#native-command-exits-numbers-and-a-durable-observation-limit)).
`result` comes from pi's
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

### Service tiers

`SessionOptions.serviceTier` is explicitly refused with
`UnsupportedOptionError`, declared in `Runtime.refusedSessionOptions`.
No per-session native setting plus applied-state readback has been verified
for this adapter; `listModels` therefore advertises no service tiers. OAR
does not silently ignore a requested tier or alter a global default.

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
configured" is an `ok` empty list. It builds them for `ListModelsOptions.cwd`
as a session there would: that project's settings can save another default,
and its extensions under `.pi/extensions` load and run. Live model setters and detailed model
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

An exactly empty `systemPrompt: ""` is refused with
`UnsupportedOptionError("systemPrompt")` before opening either an SDK or RPC
session. Pi 1.4.0's truthy `customPrompt` check otherwise silently uses its
default base prompt, rather than replacing it with empty text. A whitespace-only
replacement remains supported, and an empty `appendSystemPrompt` remains a
no-op. The [native regression](../../sea-trial/vendor/pi-empty-system-prompt.vendor.test.ts)
captured that default in the provider request before the guard; it also checks
both allowed controls in both execution modes.

**Context (mapped):** the `agent_settled` frame carries a `usage` event with
native `getContextUsage()` read at that moment (post-compaction; tokens null
when unknown), so `Session.contextUsage()` (a fold) is current at turn end.
`usage()` is the cumulative per-session total. The optional assistant
`usage.reasoning` counter (pi-ai 1.1.0) accumulates as `reasoning`, a part
already inside output. It stays absent if the provider does not report it;
reasoning text or an effort setting never supplies a count. Its input counts pi's
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

### Credential echoes

A provider can include its API key in an error message. At open, OAR asks
Pi's `ModelRegistry.getApiKeyAndHeaders` for the selected model's resolved
key, before binding extensions. A hidden `model_select` handler repeats that
lookup when an extension changes the model; Pi awaits the handler before
its next request. Values shorter than eight characters and path-shaped values
are excluded, just like explicit environment credentials; local-provider
placeholders such as `ollama` do not rewrite model IDs or reply text.
Keys already accepted remain protected for the session.
OAR reads no credential files itself and never changes the key used by Pi.

The shared [record credential rule](../spec/record-stream.md#the-rules)
redacts known keys from every retained record and projected failure reason,
as well as opening and later adapter errors. A real SDK regression uses a
local provider that reflects its received auth header in a 400 response,
then switches to a second model and key in the same session. Both keys stay
out of live records, replay, error outcomes, JSON and diagnostic inspection;
ordinary path text remains visible.

### Tools, permissions, extensions, and environment

**Partial:** `createAgentSessionServices` loads native resources and extension
provider registrations. OAR offers no general tool registration/allowlist or
extension callback interface; its custom bash tool exists to overlay
environment variables. Extensions make effective capabilities
configuration-dependent.

OAR passes project trust for this operation only and never persists a trust grant.
Extensions can still implement permission gates and interactive flows; OAR has
no general approval/user-input bridge for them. Like pi's print and rpc
modes, OAR initializes pi's theme from the settings before extensions load
(sessions, model listing and inventory), without the file watcher pi starts
only in interactive mode, so an extension tool that colors its output through
`ctx.ui.theme` runs as it does under pi's CLI. That theme is one global in
the host process, set by the latest load
([theme](../../packages/oar/src/runtimes/pi/theme.ts),
[vendor test](../../sea-trial/vendor/pi-theme.vendor.test.ts)).
`SessionOptions.env` affects
subprocesses spawned by the replacement bash tool and the session's stdio
MCP servers ([below](#session-mcp-servers)), not provider keys/base
URLs. A `null` entry removes an inherited variable from Bash children,
without changing the host environment. Pi refuses removals combined with
stdio MCP servers: see below and the
[environment contract](../spec/runtime-matrix.md#session-environment).
Provider configuration uses native model/agent-dir channels;
`OAR_PI_AGENT_DIR` is process-level, and an empty value counts as unset (as
pi treats an empty `PI_CODING_AGENT_DIR`), so it never becomes a relative
path. [Agent dir](../../packages/oar/src/runtimes/pi/resolve.ts),
[opener](../../packages/oar/src/runtimes/pi/open.ts),
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
- A tool-list change reaches the next model request with the new set
  (`mcpToolsListChanged: "full"`, pi ^1.2.0;
  [contract](../spec/runtime-matrix.md#host-served-tools)).
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
settings manager those entry points read (`OAR_PI_AGENT_DIR`, else `getAgentDir()`).
`undici` is a direct dependency of `@botiverse/oar`, pinned to the version pi
uses (8.10.2, one instance in the tree). An env proxy wins; pi's `httpProxy`
setting fills both http and https when the env names none (pi's own `??=`
precedence, but the env is not written); pi's `httpIdleTimeoutMs` setting is
the dispatcher's headers/body timeout (pi's default equals undici's). Nothing
is installed when neither a proxy nor a non-default timeout is configured, and
a global dispatcher the host already set is never replaced (the `Agent` npm
undici creates for itself counts as stock even when a bundler renamed its
class, #328). Node's own `fetch`
reads the dispatcher through `Symbol.for("undici.globalDispatcher.1")`, so the
global fetch classes stay Node's. Compressed bodies decoded in the 2026-09-11
probe (Node 26.7, whose bundled undici 8.9.0 was then also the pin), and the
live battery reaches the provider through the plane from a host with
`HTTPS_PROXY` set. Taken from pi's plane as well (pi-coding-agent 1.2.0
`core/http-dispatcher.js`), so an embedded pi connects the way `pi` does:
`allowH2: false`, `proxyTunnel: true` and a 2 s address-family attempt
timeout. Without them undici 8 negotiates HTTP/2 and sends http targets to a
proxy without a CONNECT tunnel, a protocol change pi itself avoids and one
that would reach every global `fetch` in the host; a test reads pi's file so
a change there shows up. Not taken from pi's plane: `undici.install()` and
the `"error"` listener pi puts on every undici client. When undici cannot be loaded, or the host's own dispatcher is kept,
the adapter emits one `OAR_PI_PROXY_PLANE` process warning and the session
runs on the existing dispatcher; a failed load is not cached, so a later
entry point retries. Precedence, proxying through a local stand-in, the
untouched env and the untouched global classes are pinned by
[`tests/pi/pi-http.test.ts`](../../tests/pi/pi-http.test.ts).
[HTTP plane](../../packages/oar/src/runtimes/pi/http.ts).

**Bundled hosts (mapped):** pi-ai loads its sign-in flows and its Bedrock
implementation through a computed path, so that a browser bundler does not
follow them into Node-only code. A host bundled into one file, such as a Node
single executable, has no such files beside it: every pi sign-in, OAuth turn
and Bedrock call failed with "Cannot find module" (#328). At the same points
as the HTTP plane, OAR hands pi-ai the modules itself, with the two calls pi's
own standalone binary makes (`registerBunOAuthFlows()` from
`@earendil-works/pi-ai/bun-oauth` and `setBedrockProviderModule` from
`@earendil-works/pi-ai/compat`). The imports are literal, so a bundler
follows them, and dynamic, so a host that never uses pi does not load them.
A bundled host needs no pi dependency of its own for this. The hand-over only
works when the bundle holds **one copy of pi-ai**: OAR hands the modules to
the pi-ai its own import resolves to, and pi-coding-agent runs sessions on
the pi-ai it resolves to. A package manager can resolve pi-ai twice at the
same version when the optional peers of its `openai` dependency resolve
differently in the two places, `undici` above all: pi-coding-agent pins
`undici` (8.10.2 in pi 1.2.0 and 1.3.0, and OAR pins the same), so a host
that depends on another `undici` gets a second pi-ai copy for its own imports. The bundle
then carries two copies, the hand-over lands on the one no session uses, and
every OAuth turn fails with "Cannot find module" again
([#386](https://github.com/botiverse/oar/issues/386): a daemon on `undici` 7
bundled two `pi-ai@1.1.0` variants). OAR cannot reach pi-coding-agent's copy
itself: pi-coding-agent exports only `.` and `./rpc-entry`, and a request to
export its own setup was closed without action (earendil-works/pi#10458,
the same split, from a host whose `discord.js` pinned `undici` 6). So a
bundled host resolves pi-ai once: it pins `undici` (and any other `openai`
peer it depends on: `ws`, `zod`, the AWS SDK credential provider) to the
versions pi-coding-agent resolves, checks that the bundle names a single
`@earendil-works+pi-ai@` variant, and keeps a build check that derives auth
for a dummy OAuth credential through pi-coding-agent's own `ModelRuntime`
inside the bundle: it fails with that "Cannot find module" whenever the
copies split again. Each hand-over is
best effort: a host that leaves Bedrock out of its bundle (its AWS SDK adds
about 1.4 MB) keeps every sign-in, gets one `OAR_PI_MODULES` process warning,
and Bedrock loads pi's own way; a failed hand-over is tried again on the next
call. One thing OAR does
not cover: pi reads images through photon, which loads `photon_rs_bg.wasm`
from its own directory, so a single-file host ships that file beside it or
embeds it. [Static modules](../../packages/oar/src/runtimes/pi/static-modules.ts),
[test](../../tests/pi/pi-static-modules.test.ts).

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
outside the session interface. It and `createPiModelCatalog` read
`auth.json` and `models.json` from the agent dir sessions use
(`OAR_PI_AGENT_DIR`, else pi's own), unless `authPath` or `modelsPath`
name others, so a login reaches the next session; before OAR 0.50.0 they
used pi's own dir even with `OAR_PI_AGENT_DIR` set.
[Facade paths](../../packages/oar/src/runtimes/pi/facade-runtime.ts).
The catalog's `providers()` counts a provider with a key or login in
`auth.json` as `configured` from the start, read from the file alone
without resolving the credential; `refresh()` reads the file again. Before
OAR 0.54.0 it did so only after a `refresh()`. An environment key counts only
after a `refresh()`, which is when pi resolves ambient credentials
([catalog](../../packages/oar/src/runtimes/pi/catalog.ts)). As in pi itself,
`configured` says the provider has an entry, not that its key works: an
empty key, a wrong `type` or a reference to an unset variable counts too.
OAR has **no accountUsage reader** for Pi: it
runs on provider credentials and has no subscription usage surface to
observe. An empty usable-model catalog does not establish a universal
unauthenticated state.
[Native providers][native-providers],
[installation](../../packages/oar/src/runtimes/pi/installation.ts),
[provider auth](../../packages/oar/src/runtimes/pi/auth.ts),
[runtime registration](../../packages/oar/src/runtimes/pi/index.ts).

`loginProviders()` lists what pi's own `/login` offers, straight from pi's
registry (`getLoginProviderOptions` in pi's interactive mode): every
provider of `ModelRuntime.getProviders()`, configured or not, sorted by
name, with its methods in pi's order (OAuth, then API key). OAR keeps no
list of its own and names no provider. An OAuth method carries pi's
`isSubscription` as `subscription` and the vendor's `loginLabel` ("Sign in
with ChatGPT"), which pi shows instead of "Sign in with an account" for
`/login <provider>`. An API key pi has no prompt for (`ApiKeyAuth.login`
absent) is `ambient`: pi says it is configured outside pi, and
`login`/`setApiKey` reject it. Pi's top menu is "Sign in with an account"
(the providers with an OAuth method), "Sign in with an API key" (those with
an API-key method) and, last, "Sign in with Radius", the OAuth sign-in of
provider `radius` (the gateway pi's makers run). Pi picks that entry by its
own `RADIUS_PROVIDER_ID`, which it does not export, so the list carries no
"featured" marker: one needs pi to export that id first, rather than OAR
judging pi's menu layout. On 1.1.0 the registry has 42 built-in providers,
9 with an OAuth sign-in (7 of them subscriptions; OpenRouter and Radius are
not) and 41 with an API key, none ambient. The facade loads no extensions,
so a provider an extension registers is not listed; `models.json` providers
are (`modelsPath`). The list reads no credential; `status(id)` says how each
provider is signed in. Its `subscription` is pi's `isUsingSubscription`
computed from the `checkAuth` result, since pi's own reads an availability
snapshot that the facade (`refreshOnCreate: false`) never fills, and so
said `false` for a Claude Pro/Max login.

`setApiKey(id, key)` runs pi's API-key login and answers its key prompt
(the first prompt, a secret) and nothing else. Most providers ask for the
key alone. Where the flow asks more, `setApiKey` refuses the question,
which stops the flow before pi stores anything, and rejects with an error
that names the question and says to use `login(id, "api_key",
interaction)`: on 1.1.0, amazon-bedrock and google-vertex first ask which
credential to use, and cloudflare-workers-ai and cloudflare-ai-gateway ask
for the account (and gateway) id after the key. Before OAR 0.49.0 it
answered every prompt with the key.
[Test](../../tests/providers/provider-auth.test.ts) against pi's real
registry and login flows, with fake stored credentials.

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
text and the HTTP plane, and
[`tests/providers/`](../../tests/providers/) the provider-auth bridge, the
login providers and the model catalog.

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
Pi's settings. Supply the list again on resume.

On resume, Pi 1.3.0 by itself restores the active tools recorded in the
transcript, including an earlier open's restrictions. OAR instead restores
the current native default tools and default-active extension tools before
binding `session_start`, so a resumed session with the same options has the
same tools as a new one: omitting the denylist or passing an empty list does
not retain an earlier open's exclusions. Native `excludeTools` and exposure
rules still apply, extension startup callbacks may change the selection, and
default-inactive tools are not enabled.

Pi also keeps restored names pending until a tool of that name registers.
OAR clears them before binding extensions, so a late registration cannot
reactivate a tool merely because it was active in the transcript: with Pi's
public setter it activates the registered tools, deactivates them (which
clears pending names), then applies the current defaults. If no registered
tool can be activated, OAR folds the transcript's tool additions and
removals with Pi's public helper. Resume is rejected only if that leaves
names neither registered nor explicitly listed in `disallowedTools`, since
Pi exposes no public way to clear those possible pending names: OAR
disposes the session and throws `UnsupportedOptionError`
(`option: "resume"`). Pattern-only exclusions are treated conservatively, so
they can still lead to this refusal; an empty `defaultTools` list alone does
not, while the registry still contains an activatable tool. Tool-free
conversations and histories containing only explicitly excluded or removed
tools resume; opening a new session remains available.

An unmatched native name such as `NoSuchTool` is accepted silently and
disables nothing. Neither Pi nor OAR reports that no tool matched; this
option does not validate names against the current registry.

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).
The [resume regression](../../sea-trial/vendor/pi-resume-tools.vendor.test.ts)
compares native active and callable tool names after `session_start` and the
first model request; it also checks that deliberate extension selections
survive, tool-free sessions resume, and an impossible reset fails before
extension binding.

## Launch arguments

`SessionOptions.launchArgs` is refused with `UnsupportedOptionError`: pi runs in the host process through its SDK, so a session has no command line. See [launch arguments](../spec/runtime-matrix.md#launch-arguments).

## Additional directories

A non-empty `SessionOptions.additionalDirectories` is declared refused.
The 1.1.0 SDK's session options select one cwd and expose no native additional
workspace-directory setting. Pi tools accepting absolute paths does not
provide a workspace configuration channel, and OAR does not simulate one
with prompt text or tool wrappers.

[Evidence and verification limits](../../experiments/additional-directories-2026-10-11.md).

## Structured output

`SessionOptions.outputSchema` is declared refused and fails before session
creation. Pi's SDK exposes no final-answer schema option. Tool parameter
schemas do not impose a schema on the agent's final output; OAR does not
install an extension or rewrite instructions to imitate that capability.

[Native channel audit](../../experiments/structured-output-2026-10-11.md).

## Command discovery

`commands(installation, { cwd })` opens the same kind of temporary in-memory
SDK session as the skills and tools readers. It reads
`extensionRunner.getRegisteredCommands()` and `resourceLoader.getPrompts()`.
Names use each extension command's `invocationName`, including native suffixes
for duplicate names. Sources are `extension` and `prompt`, matching Pi's
native `get_commands` catalog. Templates retain native `argumentHint`; OAR
does not turn completion callbacks into hints or return template content.

Skill entries remain exclusively in `skills()`; the command reader does not
append Pi's `skill:<name>` aliases or terminal UI built-ins. This query loads
extensions but does not bind session-start hooks or invoke handlers. Commands
registered later by a live session are outside this independent snapshot.
Native prompt or command diagnostics, or extension load errors, make `partial` true;
raw diagnostics are not exposed. Timeout cleanup also disposes a session
whose startup completes after the caller's deadline.

The [native experiment](../../experiments/commands-native.ts) and
[vendor tests](../../sea-trial/vendor/commands.vendor.test.ts) verified SDK
1.1.0 without model requests: two extensions registering the same name,
user and project templates, argument hints, unchanged skills, partial extension
load failures, workspace changes, and no persisted session or trust grant.
[Report](../../experiments/commands-2026-10-11.md).

## User configuration

`userConfiguration: "exclude"` is declared refused with
`UnsupportedOptionError` before opening a session. This adapter has no
verified separation of user configuration from native login and session
history. Omission and `"include"` retain existing behavior. See the
[shared contract](../spec/runtime-matrix.md#user-configuration).

## Orientation query costs

The host SDK path for `listModels()` creates native agent-session services for the current
workspace, loads its configuration and extensions, and asks the SDK's model
runtime for available entries. This can execute user/project code, resolve key
commands and refresh OAuth; it sends no model prompt. The orientation local
provider reader instead uses credential-list metadata and the SDK's static
subscription metadata. It does not resolve keys or refresh expired entries.
A present stored entry is reported as configured, not validated; environment-
only credentials do not appear in that stored list.

## Reader environment

In-process model listing, provider listing and supported inventories accept
`env` with their session's meaning: the inventory's replacement
Bash tool receives the overlay through its spawn hook; SDK configuration,
credential resolution and SDK-owned key commands keep the host environment.
Installation probes the bundled SDK and is independent of the overlay. OAR
never changes `process.env`.

With `execution: "subprocess"`, model, skill and command readers choose their
path on each call by comparing the overlay with the host environment. Omission,
`{}`, equal values and removal of absent variables keep the host SDK path,
without starting an RPC process. That path retains native provider display
names, the saved default model, command `argumentHint`, skill
`disableModelInvocation` and loading diagnostics. Its inventories can report
`partial:false` when discovery completes without errors.

An overlay that actually changes a host value uses one bounded native RPC
process per call. The readers reuse the session startup path:
the same `command`/`args`, version check, complete environment, agent directory,
project trust, offline policy and package preflight. They add `--no-session`
and submit no prompt. The default 15-second budget includes version checking,
startup and the query. Success, failure and timeout stop the owned process
tree and remove its private files; a timeout starts cleanup using the same
bounded shutdown grace as session disposal, so the process can outlive the
query result during that grace. Startup that finishes after the deadline
cannot launch a new process. Native startup can execute extension
`session_start` hooks, including user code and credential commands.

Models come from `get_available_models`, Pi's startup availability snapshot.
The native models retain their effort menus; RPC supplies no provider display
names or saved default, so those fields stay absent. Skills and commands come
from `get_commands`: skill entries use their native name without the `skill:`
invocation prefix and retain `sourceInfo.path`/`source`; extension and prompt
entries retain their invocation names and source labels in `commands()`.
RPC omits command `argumentHint` and skill `disableModelInvocation`; OAR does
not fill them from the host SDK. Both inventories report `partial:true` because
Pi RPC does not return loading diagnostics, so completeness cannot be confirmed.
RPC startup or model-query failures, including timeouts, reject with a generic
Error without native details. `orient()` records the rejection as `failed`, or
`timed_out` if its own budget expires first. Inventory failures retain their
`unavailable` result with `query_failed` or `timeout`.

Pi RPC exposes neither a tool nor a provider inventory. Those two readers
remain in the host SDK. In subprocess mode they reject any overlay that
actually changes a host value with `UnsupportedOptionError("env")` before SDK
loading, listing only changed variable names. Omission, `{}`, equal values,
and removing an absent variable are accepted. This also covers arbitrary
variables used by extensions, custom providers or `!` credential commands;
a fixed list of API-key variables would miss them. Revisit this fallback if
native RPC gains those queries or a host needs them under another environment.
`orient()` records the refusal as unsupported. Bundled installation discovery
remains in the host and independent of env.
See [reader environments](../spec/orientation.md#environment) and the
[native regressions](../../sea-trial/vendor/pi-rpc-readers.vendor.test.ts).
