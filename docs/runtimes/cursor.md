# Cursor

Independent inventories: not implemented for Cursor yet.
See the [query contract](../spec/inventory.md) and [native probe evidence](inventory.md).

Evidence baseline: **`@cursor/sdk` 1.0.35** (Cursor's official TypeScript
SDK, linux x64, model `gpt-5.4-nano`) on 2026-10-03 through
[`experiments/live-contract.ts cursor`](../../experiments/live-contract.ts):
12 of 12 run scenarios pass, `kill-runtime` is skipped (no process of its
own); scenario names appear in parentheses below. Statements marked "probed"
come from direct SDK probes the same day (models `composer-2.5` and
`gpt-5.4-mini`). The SDK ships compiled, with no public source, so behavior
beyond its types comes from those probes and its installed bundle, marked as
such. Versions are evidence baselines, not a support range; see the
[runtime index](README.md) for status conventions.

## Native concepts and calling interfaces

The SDK runs Cursor's agent inside the calling process, locally or as a cloud
agent; OAR uses the local runtime. A local **agent** (`agent-<uuid>`) is a
persistent conversation bound to a working directory and stored under
`~/.cursor/projects/<cwd>/` (`sdk-agent-store`, `agent-transcripts`). Each
`agent.send` starts a **run** (`run-<uuid>`), the agent loop until it ends:
`run.wait()` answers with its status (`finished`, `error`, `cancelled`), its
model and token usage; `run.steer(text)` adds input mid run; `run.cancel()`
stops it. Progress arrives through `send(…, { onDelta })` as updates, each a
record with a `type`; `run.stream()` offers a coarser message view of the
same run. An agent takes one run at a time: a second `send` while one runs is
refused (`already has active run`, probed).

The credential is `CURSOR_API_KEY`, or the key `Cursor.auth.login()` mints
and stores in `~/.cursor/sdk/auth.json`. It is separate from the Cursor CLI's
login and from the editor's.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every update is
recorded verbatim as a frame's `native`; the cross-runtime `events` are what
OAR reads out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `@cursor/sdk` package | An optional peer dependency of `@botiverse/oar` that the host installs (`@cursor/sdk@1.0.35`) and hands over through `createCursorRuntime` ([installation](#installation-and-account-usage)); the agent runs in the host process. Cursor is not in `defaultRuntimes`; the `oar` CLI depends on the SDK and adds cursor itself ([CLI registry](../../packages/cli/src/runtimes.ts)). |
| Local agent | `Session.id` is the `agentId`; `SessionOptions.resume` reopens it with `Agent.resume`. |
| Agent state after open | One `cursor/agent_opened` frame with the `model` (and `effort`) the SDK holds. |
| Run | A turn: a prompt is one `send`; `run.wait()`'s answer is the `cursor/run_result` frame carrying `turn_ended`. |
| Updates | One frame per update; a subagent's updates arrive inside its `task` call and are attributed to it (`agentPath`, tier `attributed`). |
| Steer, queue, abort | `run.steer`; an adapter-held queue sent as the next run; `run.cancel`. |

Sources: [session](../../packages/oar/src/runtimes/cursor/session.ts),
[projection](../../packages/oar/src/runtimes/cursor/projection.ts),
[model selection](../../packages/oar/src/runtimes/cursor/model.ts),
[SDK surface](../../packages/oar/src/runtimes/cursor/sdk.ts).

## Capability details

### Session creation and resume

**Mapped:** a new session is `Agent.create({ model, local: { cwd,
sandboxOptions: { enabled: false } } })`. A local agent must have a model, so
without `SessionOptions.model` OAR opens `default`, the catalog's Auto entry.
The SDK checks the model id against `Cursor.models.list()` and resolves an
alias to its catalog id (`composer` opens as `composer-2.5`); an unknown id
rejects the open with the SDK's `Cannot use this model: <id>. Available
models: …` (`bad-model`). Opening writes one `cursor/agent_opened` frame with
the SDK's `agentId` and model selection, read as `model` (and `effort`)
events.

**Resume (mapped):** `Agent.resume(agentId, …)` with the same `cwd`; an
agent is found only under the directory it was created in (`AgentNotFoundError`
otherwise, probed; [resume in another directory](resume-cwd.md)). The
resumed stream starts at seq 0 with only the `cursor/agent_opened` frame: the
SDK replays no history. A resumed agent does
not restore its own model (a `send` without one is refused, probed), so
without `SessionOptions.model` OAR reopens with the model of the agent's
latest run (`Agent.listRuns`), or `default` when it has none. The next prompt
recalls what was taught before disposal (`resume`).

The agent's store holds its last run as active until the agent object that
started that run ends it. After a process that died mid run, or a session
closed before its first prompt, every `send` on the resumed agent is refused
`already has active run` (probed). The first send after a resume therefore
passes the SDK's `local.force`, which takes the agent over; with it the
same agent answered normally (probed). Arbitrating one agent between two
live processes is the host's, as for every runtime.

```ts
const resumed = await cursor.session(installation, {
  cwd, // The directory the agent was created in.
  resume: previousSessionId, // agent-<uuid>
});
```

Sessions of the earlier cursor-agent adapter (bare UUIDs) are not SDK agents
and cannot be resumed.

### Prompt, steering, queueing, and abort

**Prompt (mapped):** `prompt()` is one `agent.send`, answered `accepted`
(with the `runId` as `native`) once the SDK returns the run, `rejected busy`
during a turn (`busy-and-late-control`), and `runtime_refused` with the SDK's
message when `send` throws, or after 60 seconds without a run (a cold start
took about four seconds). A run the SDK returns after that, or after a
dispose, is cancelled, and its end is still recorded. `InputOptions.images`
go as the SDK's image content (`{ data, mimeType }`); asked for the color of
a plain red PNG, the model answered `Red` (probed).

**Steer (mapped):** `steer()` is `run.steer(text)`, which settles once the
agent has taken the text (`complete_delivered`, the `accepted` answer's
`native.ack`) or handed it back (`revert_to_followup`, `rejected
runtime_refused`, the caller keeps the input). A steer the run ends without
taking is rejected the same way. The delivered text is echoed as a
`user-message-appended` update, read as a `user_message` event with evidence
`conversation` and no input id: the echo carries only the text. With a
foreground shell command running, a steer moves that command to the
background (its call ends at once with empty output) and the model polls it
afterwards (probed); the steered text landed in the same turn (`steer`).
`run.steer` takes text only, so a steer with images is rejected
`unsupported`. A run whose SDK object has no `run.steer` refuses the steer
`runtime_refused`: the session still has `steer`, the run declined.
`Session.deliver` does not fall back to the queue on a handed back steer;
`steerOrQueue` does.

**Queue (mapped):** `queue()` is an adapter-held FIFO
(`capabilities.queue.durable: false`) sent as a new run when the current one
ends, a spontaneous turn with no prompt request of its own (`queue`). A
queued input whose `send` the SDK refuses, or that gets no run within the
60 second send deadline, is recorded as a `cursor/send_rejected` frame, and
the queue moves on to the next.
`withdraw(inputId)` takes an input out of it before it is sent (`accepted`)
and answers `not_queued` once it was
([test](../../tests/cursor/cursor-session-withdraw.test.ts)).

**Abort (mapped):** `abort()` is `run.cancel()`; the run answers `cancelled`
within about two seconds, recorded as `turn_ended: aborted` (`abort`). An
abort that arrives before the SDK has returned the run is held and delivered
as soon as it exists.

**Outcomes:** `run.wait()`'s `finished` is completed, `cancelled` aborted,
and `error` failed with the SDK's `error.message` classified by
`classifyFailure` (a missing credential fails the first run with `[unknown]
Invalid User API Key`, read as `auth`; probed). A `run.wait()` that throws
instead records `cursor/run_failed` with the message, which ends the turn.

**Dispose (mapped):** `dispose()` gives up a `send` still on its way,
cancels a running run, waits up to five seconds for its `cancelled` answer,
closes the agent, and answers the dispose request `accepted`: an in-process
runtime has no exit to observe (`dispose-mid-turn`). The agent's stored
conversation is kept.

**Backgrounded shells hold the host process (native):** when a shell call
moves to the background (a steer, or the call's own `timeout`), the SDK arms
a 24 hour hard timeout for it that no later path clears, neither the
command's end nor `agent.close()` (the shell executor's `hardTimeout` in the
bundled `689.js`). The timer is not unref'd, so after such a turn the host
process does not exit on its own, even with every session disposed; a host
meant to end exits explicitly, as `oar run` does. Probed: a `sleep 20` that a
3 second tool timeout moved to the background left one 86400000 ms timer,
and `oar run` was still running 150 seconds after `[turn completed]` until it
exited explicitly.

### Observation, children, and history

**Mapped:** every update is one frame (`type` is the update's `type`).
`text-delta` is a `text_delta`, `thinking-delta` a `reasoning` text, and
`turn-ended` a `usage` event: its `inputTokens` exclude cache reads and
writes, so OAR adds `cacheReadTokens` and `cacheWriteTokens` to the input,
and the totals accumulate. It is the run's usage, recorded on the root; no
update reports a child's own tokens, and whether the run's figure includes a
child's is unverified. `token-delta`, `thinking-completed`,
`partial-tool-call` (a call's arguments while they stream),
`tool-requests-listed`, `step-started`, `step-completed` and
`shell-output-delta` are recorded with no events. The SDK drops its
`summary` updates before `onDelta`, so compaction is not observable, and no
update reports context occupancy, so `contextUsage()` stays empty.

**Tool frames:** `tool-call-started {callId, toolCall: {type, args}}` is
`tool_call_started` with the tool's `type` as its name (`shell`, `read`,
`edit`, `grep`, `glob`, `ls`, `task`, `mcp`, …) and the JSON args as `input`.
`tool-call-completed` carries `toolCall.result`: `{status: "success",
value}` is `result: "ok"`, `{status: "error", error}` is `"failed"`. A shell
call's content is its stdout and stderr (one empty text part when it printed
nothing) and its `exitCode` the shell's, `null` when `signal` names one (a
failing command is still a successful tool call: `ls` of a missing path ends
`ok` with exit code 2, probed); a read is the file text, an edit or write its
diff, an error its message, and any other result one `other` part. No shell
output streams while a command runs. With the model reading and editing in one step,
one read call started and never completed (probed); after a steer moved a
command to the background, the model's poll of it produced no tool updates.

**Children (mapped, `attributed`):** a subagent is the parent's `task` tool
call. Its own updates (thinking, text, its tool calls) arrive as
`tool-call-delta {callId, taskUpdate}`, keyed by the task's call id; OAR
reads `taskUpdate` as the child's update and records the frame with
`agentPath: [callId]` (`subagent`: one child path, 30 child frames). The
SDK's schema allows no `tool-call-delta` inside a `taskUpdate`, so a child's
own children are not visible. The `task` call's own result holds the child's
conversation steps. No child session or graph edge exists.

**History:** the retained stream backs `rawEvents(observer, cursor)` for the
life of the session (`cursor`); OAR enumerates no native history.

### Models, instructions, and context

**Mapped:** the [model lister](../../packages/oar/src/runtimes/cursor/list-models.ts)
is `Cursor.models.list()` (about 45 models on this account, `default` first),
`unauthenticated` without a credential, with a 15 second deadline. Each model
lists its own parameters; the reasoning one has a different id per family:
`effort` (Claude 5, Grok 4.6), `reasoning` (GPT), `reasoning_effort` (Grok
4.7, Gemini 3.8, Claude Sonnet 5.5). Several Claude models also have a
`thinking` on/off switch; the level menu wins, and a model whose only
reasoning parameter is the switch (`claude-haiku-4-5`) offers `false` and
`true`. `defaultEffort` is that parameter's value in the variant the catalog
marks default.

**Effort (mapped):** `SessionOptions.effort` is that parameter in the model
selection; the other parameters stay as the catalog's default variant sets
them (or as the resumed run had them), so a `thinking` switch stays on
beside an `effort` level (`claude-opus-5` at `low` ran with the default
variant's `thinking: true` and `context: 1m`, probed). The SDK passes an
unknown value through and reports it back as given (`reasoning: "ludicrous"`
ran, probed), so OAR checks the level against the model's menu first and
rejects the open otherwise, naming the levels.
The `model` and `effort` events come from the SDK's selection at open and
from each run's `model` in `run.wait()`; both are the selection the run was
sent with, not an independent report.

**Instructions (unsupported):** the SDK types a `systemPrompt`, but a local
agent's run fails with `unknown option '--system-prompt'` (probed), and there
is no append; OAR refuses `systemPrompt` and `appendSystemPrompt` at open
with an `UnsupportedOptionError` naming the option.

### Tools, permissions, and environment

Cursor runs its own tools in the host process tree; no request reaches the
application, and none of the scenarios asked for permission. OAR opens every
agent with the SDK's sandbox off (`sandboxOptions.enabled: false`), as every
OAR session runs by default; otherwise a `~/.cursor/sandbox.json` would turn
one on. The agent loads the user's and project's Cursor settings (rules, MCP
servers) as the SDK does by default.

**Environment (unsupported):** the SDK has no per-agent environment for
tools, and the agent shares the host's process, so a non-empty
`SessionOptions.env` is refused at open the same way. `refusedSessionOptions`
declares all three refusals before any session opens. The
`@botiverse/oar/agents` crew passes its depth variable through `env`, so it
refuses to spawn a cursor child.

**Native companion:** the agent's ripgrep and tree-sitter shell parser come
from `@cursor/sdk-<platform>-<arch>`, which the SDK finds by walking up from
the host's entry script. A layout that does not hoist it (pnpm's, a bundled
host) leaves it unfound: commands still run, but the SDK warns
`shell-parser: tree-sitter natives are unavailable in this artifact; shell
command analysis degrades to parsingFailed` and searches without its own
ripgrep. OAR resolves the package from the SDK and sets the SDK's own
`CURSOR_TREE_SITTER_VENDOR_DIR` and `CURSOR_RIPGREP_PATH` before loading it,
unless the host set them. The setting is process wide: it stays for the host
and every process it starts afterwards. Where OAR cannot resolve the package
either (a single executable with no `node_modules`), the host ships the
platform's package and sets both variables itself, as absolute paths: the
SDK ignores relative ones (Ferry CLI 0.1.35, a real turn with and without
them, 2026-10-04).

### Installation and account usage

The SDK is an optional peer rather than a dependency because it is large
(about 38 MB with its native package) and most hosts never open cursor. The
host hands it over instead of OAR looking it up:

```ts
import { createCursorRuntime, createRuntimeRegistry, defaultRuntimes } from "@botiverse/oar";

const cursor = createCursorRuntime({ sdk: () => import("@cursor/sdk") });
const registry = createRuntimeRegistry([...defaultRuntimes.list(), cursor]);
```

The import sits in the host's own code, so a missing package fails the
host's compile rather than surfacing at run time (`skipLibCheck` does not
hide it), TypeScript checks the SDK's types against the exported `CursorSdk`
(the part OAR uses), and a bundler sees the import. OAR calls the loader on
the first call that needs the SDK, and again after a failed load. OAR's
published declarations spell out those SDK types instead of importing them,
so a host without the SDK still type-checks. CI checks both sides on a clean
install of the packed packages: without the SDK the line above fails to
compile and everything else works; with it, cursor loads
([test](../../tests/clean-install.ts)). The rule behind this is in
[capabilities](../design/capabilities.md#a-runtimes-own-settings).

[Installation](../../packages/oar/src/runtimes/cursor/installation.ts) is
`bundled`, like pi: versionless (the embedder pins the SDK) and available
wherever the SDK ships a native package (darwin arm64 and x64, linux arm64
and x64, win32 x64), `unsupported` elsewhere. It does not look for the
package, which would mean loading the SDK; where the package is missing
anyway (a plain JavaScript host, a deploy that left it out) the first call
that needs the SDK fails with `cursor could not load @cursor/sdk through the
host's sdk loader`, carrying the loader's error as its cause. There is no
update check or upgrade: the supported SDK version moves with OAR's own,
pinned exactly by the peer dependency.

Account usage is **unexposed**: `agent.getUsage()` answers `feature_unavailable`
on this account (probed), and each run reports its own tokens.

## Verification and open gaps

[`experiments/live-contract.ts cursor`](../../experiments/live-contract.ts)
covers the promises above on a real login: `basic`, `multi-turn`,
`tool-detail`, `busy-and-late-control`, `steer`, `queue`, `abort`,
`dispose-mid-turn`, `cursor`, `resume`, `subagent`, `bad-model`.
[Cursor tests](../../tests/cursor/) drive the session with a stand-in SDK
(prompt, busy, steer delivered, handed back and outrun, images, queue,
withdraw, abort before and after the run exists, dispose, resume, refused
options, the SDK loader) and fold
recorded updates (tools, usage, the subagent path, run outcomes). The
[real-runtime CI matrix](../../.github/workflows/ci.yml) excludes Cursor.

Open gaps: login through OAR; a crew child (no environment); tool calls the
SDK runs without updates; the cloud runtime; Windows and macOS live runs.
Keep native API capabilities, SDK limitations, OAR omissions and unexecuted
checks separate when designing or claiming support.
