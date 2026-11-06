# DeepSeek Harness (DSH)

OAR reaches DSH through its own plugin host, not through DSH's ACP server. Each
session owns one `dsh --profile acp --patch <private file>` process with the
`acp` protocol plugin disabled and a private bridge plugin inserted by its
absolute file URL. The profile supplies the native core and its stdin shutdown; no ACP message
is exchanged. Runtime id `dsh`, placement isolated only.

Native evidence: the [plugin probe](../../experiments/dsh-plugin/README.md) and
`sea-trial/vendor/dsh*.vendor.test.ts` against the real CLI with a loopback
provider. Run on Linux x64, Node 24, on 2026-11-05:

| Version | Vendor tests | Shared behavior suite |
|---|---|---|
| 0.2.1-rc.5 (CI pin) | 18 passed | 18 passed, 1 skipped by capability (`accountUsage`) |
| 0.2.2-alpha.2 | 18 passed | 18 passed, 1 skipped by capability |
| 0.2.2-rc.1 (`latest` and `next` on November 5) | 18 passed | 18 passed, 1 skipped by capability |

The [daily version inventory](../../experiments/runtime-versions.ts) compares
`@deepseek-ai/dsh`'s npm `latest` with `OAR_DSH_BIN` or `dsh` on PATH. Each new
version gets its own loopback-provider behavior and vendor runs; the CI pin
remains separate. [November 5 evidence](../../experiments/runtime-version-checks/2026-11-05.md).

Real provider: Bugen ran `d6e41da` on Linux with a real DeepSeek API key
(pay-per-use, not a first-party plan), model `deepseek-official/deepseek-flash`,
effort low, on dsh 0.2.2-rc.1 and 0.2.1-rc.5: inference, tool call, resume, mid-turn
cancel and usage passed. 0.2.2-alpha.2 was not run on a real key.

The corrected fixtures also passed with 0.2.1-rc.5 in CI run 42078076588:
[macOS](https://github.com/botiverse/oar/actions/runs/42078076588/job/127423516264)
had 18 vendor cases and 18 behavior cases pass;
[Windows](https://github.com/botiverse/oar/actions/runs/42078076588/job/127423516172)
had 17 vendor cases and 18 behavior cases pass. Each behavior suite skipped
`accountUsage`; Windows also skipped the POSIX-only mid-turn process-kill case.
These platform results cover the CI pin, not 0.2.2-rc.1.

## Native interface

DSH is a Cordis plugin tree. Injected services, with no package import:

- `agents`: `create({sessionId, meta: {cwd}, agentOptions})`, `resume({resumeSessionId, agentOptions})`, returning a handle with `agent` and `dispose()`.
- `agent`: `status`, `followup(message)`, `steer(message)`, `cancel(cause, {keepInbox})`, `inbox.nextTurn`, `inbox.nextStep`, `inbox.remove(id)`; `agent.model.current()` and `select()` from 0.2.2-alpha.2, absent on 0.2.1-rc.5.
- `llm.resolveCallConfig(route)`: validates a route and effort before any provider request; `llm.listProviders()`, `listModels(provider)`, `resolveModelInfo(provider, model)`: the catalog; `agentDefaultModel.currentSelection()`: the configured default.
- `sessionPersistence.open(id, "read")`: the saved header and log without taking the session over.
- Events: `session/event` (the durable log), `agent/assistant-stream` (transient chunks), `agent/status`, `agent/error`, `subagent/start`, `subagent/end`.

A package outside a profile cannot import `@deepseek-ai/*`
([evidence](../../experiments/dsh-plugin/README.md)), so the bridge
(`packages/oar/src/runtimes/dsh/bridge.ts`) uses only these services and Node
built-ins. It is a string written to a private 0700 directory per open, so
bundled and single-file hosts work without a packaging asset. The internal
transport is not a public protocol: a first `ready` frame with the service
inventory, or `startup-error` when the loader barrier fails (never an empty
inventory); `response` frames for commands; `native` frames carrying the payload
unchanged with routing fields beside it; `protocol-error` for a line that is no
command.

## Version policy

Floor, not an exact list: `DSH_MINIMUM_VERSION` is `0.2.1-rc.5`, compared by
semver prerelease ordering. Below it, or with an unreadable version,
`installation` answers `unsupported` naming the version and `session()` rejects
`RuntimeFailureError` (`invalid_request`). Above it, the startup and per-agent
method inventory decide: a missing method removes or refuses its control with the
reason (below), and records keep the native frames. Method presence does not prove
semantics, so the table above states what was actually run; the runtime version
checks should run this suite on each new release. Reopen the floor if a release
changes semantics silently.

A concrete semantic difference: from 0.2.2-alpha.2 a resumed session keeps its
recorded selection over `agentOptions`, so the bridge calls `agent.model.select`
when the host asks for another model or effort on resume. On 0.2.1-rc.5
`agentOptions` applies directly. The vendor tests pin that the requested route
reaches the provider on both. Where the runtime reports its selection at open and
it differs from the request, the open is refused rather than run.

## OAR mapping

| OAR | Native | Notes |
|---|---|---|
| open | `agents.create` | `Session.id` is the native id, supplied by OAR. Omitted model: `agentDefaultModel.currentSelection()`. Explicit model or effort: `llm.resolveCallConfig` first, so a route that cannot run is refused at open, and without that method the request is refused rather than run unchecked. |
| resume | `sessionPersistence.open(id, "read")`, then `agents.resume` | Saved header compared with `options.cwd` using the [shared directory check](resume-cwd.md); another directory is `UnsupportedOptionError("cwd")` before the session is taken over. Omitted model keeps the saved route from the last `request/header`. Missing: `SessionNotFoundError`. |
| prompt | `agent.followup` when `status` is idle | Rejected `busy` otherwise. The native claim starts the turn; accepted means delivered. |
| steer | `agent.steer` | Rejected `no_active_turn` when idle. Native `next-step` inbox; the input joins at the next step boundary, including when the model had just stopped. |
| queue | `agent.followup` | Native `next-turn` inbox. While idle it starts a turn at once. |
| withdraw | `inbox.remove(id)` | Only an input in `nextTurn`: a steer may already be in the next request. `not_queued` when native says it is gone. |
| abort | `agent.cancel({kind: "user"}, {keepInbox: false})` | Accepted is delivery; the outcome is the native `turn/end`. Pending inbox entries are discarded natively and reported as `input_dropped`. `keepInbox: true` would leave them stranded on an idle agent. A 10-second fallback kills the process if no turn end follows. |
| dispose | `handle.dispose()`, `persistence.flush()`, stdin close | Native turn end `aborted` with `{kind: "disposed"}`; pending inbox entries are discarded natively. The process owner bounds shutdown and removes survivors; the `exited` response answers the request. |

`inject` has no OAR control and is not exposed.

Inputs carry their `inputId` as the native message id, which the durable log
returns: `user/message` gives `user_message` with `evidence: "turn_item"`, and a
`next-turn` claim gives `turn_active { inputId }`. A turn native started with
nothing waiting gives `turn_active` with no id. `input_queued` is emitted only for a prompt held behind
input a crashed process left waiting; otherwise a claim follows at once, and a
queued input's withdrawal is not a native drop, which the status fold's pending slot
could not tell apart.

A missing native method: `prompt` and `queue` without `followup`, and `abort`
without `cancel`, are rejected `unsupported` with the reason. `steer` without
`agent.steer` and `withdraw` without `inbox.remove` are absent members, as the
contract asks, with `dsh/opened` keeping the inventory that says why. `create`
missing rejects the open (`RuntimeFailureError`); `resume` or a saved-session
read missing rejects a resume (`UnsupportedOptionError("resume")`); a model or effort
without `llm.resolveCallConfig` rejects (`UnsupportedOptionError("model")`, `("effort")`).

### Records

The projection (`projection.ts`) is a pure fold, replay-tested against the
captured probe frames of both versions. One native payload is one frame, its
`native` unchanged:

| Frame type | Events |
|---|---|
| `session/event:<type>` | durable log; see below; an unknown type stays a frame with no events |
| `agent/assistant-stream` | `text_delta`, `reasoning`, `tool_call_input_delta` from transient chunks, with the native `attemptId` as `messageId` |
| `agent/status` | none |
| `agent/error` | none; the native error object is structured, cause chain included (the probe kept only a string) |
| `subagent/start`, `subagent/end` | `task_started`, `task_ended` keyed by the native `runId`, on the root; `completed`, `aborted` is `stopped`, any other reason is `failed` |
| `session/event:job/registered`, `session/event:job/settled` | `task_started`, `task_ended` keyed by native `jobId`, on the owning session; `bash` and `pwsh` are `shell`, other producer kinds are `other` with `nativeType` retained |
| `dsh/ready`, `dsh/opened`, `dsh/stdout`, `dsh/protocol-error`, `dsh/dispose-failed` | none, except `dsh/opened` reporting a selection on versions that read one |

Durable events read: `turn/start`, `turn/end` (`turn_ended`), `agent/inbox/spliced`,
`user/message` (only `source.kind: "user"`), `tool/call` (`tool_call_started`),
`tool/result` (`tool_call_ended` with `isError` as `result`), `request/header`
(`model` as `provider/model`, `effort`), `request/context` (window),
`assistant/message` and `assistant/attempt` (usage), `subagent/catalog`
(`session_linked`), `compaction/start` and `compaction/end`. `assistant/message`
adds no second text. Compaction reads are from the source and unit-tested, not yet
exercised natively.

Job events carry their native `toolCall.callId` and label. Settlement maps
`completed` and `failed` directly, and `killed` to `stopped`; unknown results
remain raw. The native event does not identify background execution, so the
projection leaves `background` absent and also reports foreground jobs. Copied
history whose `owner` differs from the containing session stays raw. Settlement
is a native registry fact, not proof that every OS descendant exited: `cause`
and `producerReported` remain in the original frame.

`Session.model()` and `effort()` are folds: null until a request header says them
on 0.2.1-rc.5 (no `agent.model`), reported at open from 0.2.2-alpha.2.

Tokens are native. `inputTokens` excludes the cache counts DSH reports beside it,
so `input` adds them (60 fresh plus 40 cached is 100). A failed attempt's usage
chunk counts when nonzero. `reasoning` copies `reasoningTokens` where reported;
the provider route tested does not pass it on. Context uses the committed call's
`totalTokens` over the last `request/context` window.

Turn ends: `completed`; `aborted`; `error` by native code (below);
`max-tokens` is `failed` `limit_reached`; `blocked` and any later kind are `failed`
`unknown`, naming it; `interrupted` is `failed` `runtime_exited`.

Failure codes: `AUTH`, `INVALID_CREDENTIAL` `auth`; `QUOTA`, `ACCOUNT_QUOTA`
`quota`; `RATE_LIMIT` `rate_limited`; `CONTEXT_WINDOW_EXCEEDED` `input_too_large`;
`UNKNOWN_MODEL`, `NO_ADAPTER` `model_unavailable`; `INVALID_REQUEST`,
`UNSUPPORTED_REASONING_EFFORT` `invalid_request`; `SERVER` `provider`; otherwise a
reported `status`; otherwise `unknown`. Observed against a scripted provider:
401 `AUTH`, 429 `RATE_LIMIT`, 500 `SERVER`, 400 `INVALID_REQUEST`, `UNKNOWN_MODEL`,
`NO_ADAPTER`, `UNSUPPORTED_REASONING_EFFORT`. A 402 arrives as `PI_AI_ERROR` with
the status only in prose, so it stays `unknown`. The rest are constants in the
0.2.1-rc.5 source, not seen on a wire. DSH retries 429 and 5xx itself (six attempts
over about 15 seconds), each recorded as `assistant/attempt`; it does not announce
a retry, so no `retry` event is read.

### Children

`capabilities.attribution` is `nested`. Child session frames carry the child's own
`sessionId`; the parent's durable `subagent/catalog` names the child and is the
only lineage edge (`session_linked`, `via: "tool_call"`), which `graph()` holds.
`subagent/start` alone names no parent, so its task event sits on the root with
`childSessionId` set. The native `subagent` tool returns at once and the child runs
in the background: the parent's turn ends first, and when the child settles DSH
gives the parent a turn of its own with a `subagent-settled` input under a native
id. A host prompt during that turn is `busy`, as with any spontaneous turn.
`usage().withChildren` sums the child's own records.

### Root completion and background work

`turn_ended`, `awaitTurnEnd` and an idle root status describe the root turn.
They do not say that its children or shell jobs have finished. At that boundary,
`tasksOf(session.records(), session.id).value` includes their reported states;
`pending`, `running` and `paused` rows still represent unfinished work. Keep the
session and its tool-routing context available while those tasks run.

Under DSH's default `tool-jobs` `completionDelivery: "wakeup"`, an uncollected
shell result can start another root turn, just as `subagent-settled` can. That
turn can call tools. Do not dispose at `task_ended`: it can precede the wake.
For these wake-enabled flows, wait for the ensuing root turn to end and inspect
the task list again; the follow-up may itself launch more work. This is not a
universal session-complete signal.

The [settlement probes](../../experiments/dsh-settlement-notifications/README.md)
on DSH 0.2.1-rc.5 and 0.2.2-rc.1, Linux with local providers, distinguish these
native outcomes:

- A successful model `job_kill`, or completion collected by a waiting
  `job_output(wait: true)`, suppresses the completion notice. The job settlement
  is still recorded, but there is no separate "no notification" record. An
  earlier read that returned a running job is not this case.
- `completionDelivery: "quiet"` and an exhausted `maxConsecutiveWakes` budget
  still persist a notice in the `next-step` inbox. In the probes the agent stayed
  idle with that notice pending until a later host input consumed it.
- The job's `job/settled` record precedes notice insertion. An empty inbox at
  that record does not yet describe its notification decision. For the tested
  subagent completions, notification insertion precedes `subagent/end`; the
  notice may already have been claimed by then. The jobs plugin's `quiet`
  setting does not govern subagents.

A host can reconstruct currently queued notifications by applying native
`agent/inbox/spliced` records in order to the `next-turn` and `next-step` lists:
splice at `start`, remove `removedCount`, and insert `inserted`. OAR retains
these events in `session/event:agent/inbox/spliced` frames, with the original
event in `body.native`. Notice sources include `tool-jobs` and
`subagent-settled`; claiming or cancellation removes them. An empty inbox does
not mean that no notification or turn can arrive later. Neither the inbox
target nor `task_ended` is a durable wake decision for each settlement. OAR
does not infer that missing fact or rely on undocumented `turn/start.cause`.

A spontaneous turn can have a native `inputId` with no corresponding host
request. Its durable `user/message` records the source, such as `tool-jobs` or
`subagent-settled`; that notification is not projected as a host `user_message`.
Attribute tool calls by their session and native turn, not by assuming every
turn has a new host prompt or every spontaneous turn lacks an input id.

[Background-work probes](../../experiments/dsh-background-work/README.md) held
child and shell completion until after the root turn using DSH 0.2.1-rc.5 and
0.2.2-rc.1 on Linux with local providers. Child task events already existed;
shell job events fill the missing part of that observation. The shell regression
also passed on Linux, macOS and Windows in CI with DSH 0.2.1-rc.5. The report
links those results and keeps the manual Claude/Codex comparisons scoped to
Linux.

## Session options

Supported: `cwd`, `resume`, `env`, `model` as `provider/model` (a bare name is
refused at open: it has no route), `effort` as `reasoningEffort`, and stdio
`mcpServers` with command/args ([MCP details](#session-mcp-servers)).

`DSH_PERMISSION_MODE` is `danger-full-access` unless the host names its own for this
session in `SessionOptions.env`: nobody sits at an approval prompt, and native reports
`approval/policy: never` so an action needing approval is rejected. Verified that
tools run and the native `permission/preset` frame is recorded.

Refused with `UnsupportedOptionError`, each until its own probe:
`systemPrompt`, `appendSystemPrompt`, `disallowedTools`, `launchArgs`,
`serviceTier`, `additionalDirectories`, `outputSchema`, `name`,
`userConfiguration: "exclude"`, `goals: true`, `endTurnProcessesOnAbort: true`. Images are not sent:
`capabilities.images` is false and an input with images is rejected `unsupported`.
`queue.durable` is false: native dispose clears the inbox (measured). After a SIGKILL,
one probe on 0.2.1-rc.5 found the queued input still in the log: it does not run at
resume, `dsh/opened` reports it as `pending`, and it runs at the next wake, ahead of
the prompt that woke it. Flush timing has not been established, so OAR promises
nothing here. Login, auth status and account usage are absent. Manual compaction is undeclared, meaning
untested. Inventories answer `unsupported`.

## Models

`listModels` starts a short-lived process the way a session does and reads the native
catalog: `id` is the `provider/model` selector, with display names, `effortLevels`
and `defaultEffort` from `resolveModelInfo`, and `default` from
`agentDefaultModel`. A provider that fails to list is left out; if none listed
anything and one failed, the answer is `unsupported` with the native reasons. A
missing method answers `unsupported`, and an executable below the floor does too, read
from the executable when the installation names no version. Whether
`deepseek-official` lists without credentials has not been run; `unauthenticated` is
never answered because no native evidence for it exists yet.

## Installation and configuration

`installation` looks for `OAR_DSH_BIN`, then `dsh` on PATH. `installPlan` and
`install` run `npm install -g @deepseek-ai/dsh` (Node 24.9 or later). DSH's
default route is `deepseek-official`, with an API key; see the real-provider run above. Any other route goes in the user's own patch, for example
`$DSH_HOME/cordis.patch.yml` with `llm-pi-ai` providers and `agent-default-model`,
which is what the test fixture does.

OAR writes nothing to user configuration: its overlay is an invocation `--patch` in
a private directory. DSH itself writes under `DSH_HOME` (default `~/.dsh`): cold
start creates `profiles/acp/{package.json,pnpm-workspace.yaml,cordis.yml,cordis.patch.yml}`,
and sessions write `sessions/<cwd key>/<id>/` logs and locks and
`storages/session_projcache/`. Telemetry and session-log settings stay the user's; the
test home turns them off with `DSH_TELEMETRY_DISABLED` and disabled plugin rows.
Six concurrent cold opens on one fresh home all succeeded (four rounds, Linux).
DSH also creates `dsh-spill-*` and `dsh-subprocess-*` directories in the system
temporary directory and leaves them there empty; with one process per session they
accumulate. They are DSH's own, so OAR does not remove them.

## Testing

`OAR_DSH_BIN=<dsh> OAR_TEST=dsh-aimock pnpm sea-trial` and
`OAR_TEST=dsh-aimock pnpm vitest run sea-trial/vendor/dsh`. Home:
[`sea-trial/harness/dsh-aimock.ts`](../../sea-trial/harness/dsh-aimock.ts): fresh
HOME and DSH_HOME, a synthetic key, a loopback route. The durable-equality test
reads the native `session.v4.jsonl.zstd` directly, every Zstandard frame of it (Node
24.19's one-shot decoder returns only the first, 24.22's all), and compares it with
the forwarded frames. The missing-method test inserts a plugin that strips methods from
real agents. Stand-in faults: `tests/dsh/`, with `tests/fixtures/fake-dsh.mjs`
running the real bridge text over fake services.

A first request on Windows carries a third user message, a `skill-catalog` system
reminder offering the bundled `diagnose-windows-sandbox-acl` skill (seen in the CI
trace), after the input and the runtime context, which the fixture's `lastInput` now
skips. DSH's shell tool there is `pwsh`, not `bash`.

## Session MCP servers

`SessionOptions.mcpServers` accepts stdio `command` and `args`. OAR adds one
native `@deepseek-ai/dsh-mcp-client` loader row per server to its private
invocation patch. Each OAR session owns that process, so these rows do not
modify the user's profile or attach to another OAR session. `cwd` is the
session directory; arguments go directly to the native transport, without a
shell. Tools have native names such as `mcp__echo__echo`.

Native loading is verified before open: `loader.await()` alone settles even
when an individual plugin failed. The bridge then finds each requested row
through `loader.entries()`, awaits its fiber and requires native ACTIVE state.
A missing method, failed server or inactive plugin refuses the open. The check
uses native `FiberState.ACTIVE = 2`, measured by the linked MCP probe. If DSH
changes that enum, MCP opens will be refused until the mapping is updated.
The latest-version vendor probe covers this dependency. Existing
user-configured servers remain; a namespace collision fails native activation
instead of replacing the user's server. Names must match the native
`[A-Za-z0-9_-]{1,32}` constraint; OAR refuses other names without renaming them.

Supply the entries again on resume. A resumed process without them has no
current tools from those entries, even though conversation history retains
previous tool results. Native disposal and OAR's process owner close the MCP
children. Failed startup also cleans up children that already started.

HTTP entries and nonempty `env` or `headers` are refused before launch.
`refusedSessionOptions.mcpServerCredentials` declares the credential refusal:
DSH's persistence of those values has not been audited. This does not claim
that DSH itself lacks these transports or configuration fields. Empty `env`
is allowed. Persistence of command/args has not been audited either. Do not
move tokens into `args`; this path is not a credential channel.

[Native probe and regressions](../../experiments/dsh-mcp/README.md) cover
loopback model calls, process identity/cwd/arguments, simultaneous sessions,
configured servers, resume with supplied/omitted entries, failure and disposal.

## Open risks

Image input, the flush timing of pending input before a crash and
pipe backpressure with a slow host are unverified. Only the test that kills the
process from a tool skips on Windows.
