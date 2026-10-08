# Cursor

Independent inventories: not implemented for Cursor yet.
See the [query contract](../spec/inventory.md) and [native probe evidence](inventory.md).

Initial evidence baseline: **`@cursor/sdk` 1.0.35** (Cursor's official TypeScript
SDK, linux x64, model `gpt-5.4-nano`) on 2026-10-03 through
[`experiments/live-contract.ts cursor`](../../experiments/live-contract.ts):
12 of 12 run scenarios pass, `kill-runtime` is skipped (no process of its
own); scenario names appear in parentheses below. Statements marked "probed"
come from direct SDK probes the same day (models `composer-2.5` and
`gpt-5.4-mini`). The SDK ships compiled, with no public source, so behavior
beyond its types comes from those probes and its installed bundle, marked as
such. Versions are evidence baselines, not a support range; see the
[runtime index](README.md) for status conventions.

Current required SDK: **1.0.37**, the exact optional peer version. Hosts
using Cursor install that version alongside OAR; the CLI installs it itself.
The pin matches CI and does not promise support for older SDKs. On
2026-10-08 the native login/logout probe passed all 11 scenarios against a
local substitute backend with other network access blocked; the public
session, model and auth declarations remain compatible. The last complete
live session battery was **1.0.36** on 2026-10-06 (Linux x64, Node 24.19.0,
`gpt-5.4-nano`): all 12 applicable scenarios passed, and `kill-runtime`
remains inapplicable. Live model sessions have not been rechecked on 1.0.37.
See the [October 8 report](../../experiments/runtime-version-checks/2026-10-08.md)
and [October 6 live evidence](../../experiments/runtime-version-checks/2026-10-06.md).

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

The credential is `CURSOR_API_KEY`, or, without it, the key
`Cursor.auth.login()` mints and stores in `~/.cursor/sdk/auth.json`. It is
separate from the Cursor CLI's login and from the editor's. OAR drives that
login and reads its status ([login](#login)).

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every update is
recorded verbatim as a frame's `native`; the cross-runtime `events` are what
OAR reads out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `@cursor/sdk` package | An optional peer dependency of `@botiverse/oar` that the host installs (`@cursor/sdk@1.0.37`) and hands over through `createCursorRuntime` ([installation](#installation-and-account-usage)); the agent runs in the host process. Cursor is not in `defaultRuntimes`; the `oar` CLI depends on the SDK and adds cursor itself ([CLI registry](../../packages/cli/src/runtimes.ts)). |
| Local agent | `Session.id` is the `agentId`; `SessionOptions.resume` reopens it with `Agent.resume`. |
| Agent state after open | One `cursor/agent_opened` frame with the `model` (and `effort`) the SDK holds. |
| Run | A turn: a prompt is one `send`; `run.wait()`'s answer is the `cursor/run_result` frame carrying `turn_ended`. |
| Updates | One frame per update; a subagent's updates arrive inside its `task` call and are attributed to it (`agentPath`, tier `attributed`). |
| Steer, queue, abort | `run.steer`; an adapter-held queue sent as the next run; `run.cancel`. |
| `Cursor.auth` | `login` is `Cursor.auth.login` (the URL relayed, the SDK polls), `logout` is `Cursor.auth.logout` (local only: the minted key is not revoked), `authStatus` is `Cursor.auth.status` ([login](#login), [logout](#logout)). |

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

### Interrupted input

SDK 1.0.36 keeps `run.steer()` pending on its internal
`confirm_steering` acknowledgement. Only `complete_delivered` becomes
OAR `accepted`; `revert_to_followup`, including the SDK's cleanup of
undelivered steering when the run ends, is a refusal. OAR also races a
pending steer against the recorded run end, so cancellation cannot leave
an unanswered control. No accepted unread steering was established and
no `input_dropped` rule is added.

This audit inspected installed `run.d.ts` and `dist/esm/867.js` and exercised
the SDK-facing adapter tests. The Cursor agent streaming backend was not
reproduced locally, and no account was used; backend delivery behavior in
this abort race remains unverified.
[Audit](../../experiments/input-interruption-2026-10-08.md).

### Prompt, steering, queueing, and abort

**Prompt (mapped):** `prompt()` is one `agent.send`, answered `accepted`
(with the `runId` as `native`) once the SDK returns the run, `rejected busy`
during a turn (`busy-and-late-control`), and `runtime_refused` with the SDK's
message when `send` throws, or after 60 seconds without a run (a cold start
took about four seconds). A run the SDK returns after that, or after a
dispose, is cancelled, and its end is still recorded. `InputOptions.images`
go as the SDK's image content (`{ data, mimeType }`); asked for the color of
a plain red PNG, the model answered `Red` (probed).

For an image-only prompt or queued input, OAR passes
`{ text: "", images: [...] }` to `agent.send`. This SDK call shape is covered
by the [stand-in test](../../tests/cursor/cursor-session.test.ts).
How the Cursor backend processes the empty text has **not been verified**;
there is no reusable local agent backend for that probe. An image-only
steer remains unsupported because `run.steer` takes text only.

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
and `error` failed with the SDK's `error.message` classified from its words,
the last resort, as the run error carries no code (a missing credential fails
the first run with `[unknown] Invalid User API Key`, read as `auth`; probed).
A made-up `CURSOR_API_KEY` fails the open instead: `Agent.create` checks the
key with Cursor's service and rejects with `AuthenticationError` (401), which
`session()` rejects as a `RuntimeFailureError` (`auth`, `rejected`;
[failure evidence](../spec/runtime-matrix.md#cursor)). A `run.wait()` that
throws instead records `cursor/run_failed` with the message, which ends the
turn.

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
meant to end exits explicitly, as `oar run` does. Probed on SDK 1.0.35
(2026-10-04): a `sleep 20` that a 3 second tool timeout moved to the
background left one 86400000 ms timer, and `oar run` was still running 150
seconds after `[turn completed]` until it exited explicitly. SDK 1.0.36
(checked 2026-10-06) has the same code, in a bundle file renamed `867.js`,
and so does 1.0.37 (checked 2026-10-08, `464.js`: the backgrounded branch
still skips `clearTimeout` and hands the timer to no one).
Reported upstream on 2026-10-07
([forum post](https://forum.cursor.com/t/cursor-sdk-1-0-35-and-1-0-36-a-backgrounded-shell-call-keeps-the-node-process-alive-for-24-hours/173928));
Cursor reproduced it the same day, called it unintended, and named exiting
explicitly after `agent.close()` as the workaround until a fix.

### Observation, children, and history

**Mapped:** every update is one frame (`type` is the update's `type`).
`text-delta` is a `text_delta`, `thinking-delta` a `reasoning` text, and
`turn-ended` a `usage` event: its `inputTokens` exclude cache reads and
writes, so OAR adds `cacheReadTokens` and `cacheWriteTokens` to the input,
and the totals accumulate; the two also accumulate as `cacheRead` and
`cacheWrite` (required numbers in SDK 1.0.36's `TurnEndedUpdateSchema`, so
both are present once a turn reported usage;
[spec](../spec/attribution.md#cache-reads-and-writes)). It is the run's usage, recorded on the root; no
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
one on. OAR sets no `settingSources`, so the SDK's default decides which of
the user's and project's Cursor settings the agent loads. Measured only
against a hand-scripted stand-in for Cursor's backend, that default read
neither `~/.cursor/mcp.json` nor the project's `.cursor/mcp.json`
([session MCP servers](#session-mcp-servers)); rules were not part of that
measurement.

**Environment (unsupported):** the SDK has no per-agent environment for
tools, and the agent shares the host's process, so a non-empty
`SessionOptions.env` is refused at open the same way, including a map whose
only entries are `null` removals. `refusedSessionOptions`
declares these refusals, and the `mcpServers` one
([below](#session-mcp-servers)), before any session opens. The
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

### Session MCP servers

**Refused:** a non-empty `SessionOptions.mcpServers` fails the open with an
`UnsupportedOptionError`
([model selection](../../packages/oar/src/runtimes/cursor/model.ts)): "OAR
does not attach MCP servers to cursor yet: Cursor's agent runs on Cursor's
servers, and no run without a login or paid tokens shows it calling a tool
of the SDK's Agent.create mcpServers".

The SDK has the channel. Its 1.0.36 bundle (`dist/esm/options.d.ts`) types
`AgentOptions.mcpServers` as `Record<string, McpServerConfig>`: stdio
`{type?: "stdio", command, args?, env?, cwd?}`, remote `{type?: "http" |
"sse", url, headers?, auth?: {CLIENT_ID, CLIENT_SECRET?, scopes?}}`.
`Agent.resume` takes it too, and a per-send `mcpServers` replaces the whole
set. Measured only against a hand-scripted stand-in for Cursor's backend
(`CURSOR_BACKEND_URL`, Connect/protobuf; not in the repo, and aimock cannot
serve it), network-isolated, with no key:

- The SDK starts nothing at `Agent.create`. It spawns a stdio server at the
  first `send` and runs a `tools/call` when the backend asks for one
  (`echo-echo`); the echo it returned showed the entry's `env` credential
  had reached the server. An http server worked too, and both did after
  `Agent.resume`.
- A server with a bad command is dropped silently.
- Under the SDK's default `settingSources` the agent read neither
  `~/.cursor/mcp.json` nor `.cursor/mcp.json`; with `["project", "user"]`
  the inline entry won a name clash.

That stand-in is not Cursor: the agent loop and the model run on Cursor's
servers, so only a live run (a login, paid tokens) can show Cursor's agent
choosing the tool, and what `tool_call` deltas OAR records for it (the
stand-in sent none). Before the option is enabled, a live run must show a
`tool_call` delta naming the MCP tool with the echo string in its result, on
open and again after `Agent.resume`, and no `env` or header value in any
delta or option record.

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

### Login

**Mapped** ([runtime login](../spec/login.md)):
`login` is the SDK's own `Cursor.auth.login`, `authStatus` its
`Cursor.auth.status`. Native behavior [bundle 1.0.35: `dist/esm/index.js`,
`Cursor.auth` and `src/agent/auth/*`, with their `.d.ts`]: the login makes a
PKCE handshake and calls `onLoginUrl(url)` at once, with a
`cursor.com/loginDeepControl?challenge=…&uuid=…` page; with
`openBrowser: false` it opens no browser and prints nothing. It then polls
`POST /auth/poll` until the sign-in in the browser completes: 150 attempts
backing off from 1 to 10 seconds, about 24 minutes, after which (or after
three failed requests in a row) it throws `Login failed or timed out. Please
try again.` With the session token it mints a user API key that expires in
90 days (`createUserApiKey`, listed as `Cursor SDK login (<hostname>)` among
the dashboard's API keys), reads the account's email (`getMe`), drops the
session token, and saves `{ backendUrl, apiKey, apiKeyExpiresAtMs, email,
createdAtMs }` to its credential store, by default `~/.cursor/sdk/auth.json`
(mode 0600). It writes nothing before that save and clears nothing, so a
login that fails leaves the previous one as it was. The SDK's `signal` stops
the poll (checked before each attempt, passed to each request, and waking
the backoff; the login then throws `Login was cancelled.`), but the minting
takes no signal, and the save follows it whatever the signal says.
`status()` reads only the file: `logged-out` when it is missing, unreadable
or past its expiry, else `logged-in` with `backendUrl`, `email` and
`apiKeyExpiresAtMs`, never the key.

OAR passes `openBrowser: false` and relays the URL from `onLoginUrl` as one
`auth_url` event; nothing is pasted back. The abort the SDK would ignore is
handled by the store OAR passes in place of the default: while the login
waits, it hands the SDK's save, unread, to the SDK's own
`FileCredentialStore` (the same `~/.cursor/sdk/auth.json`); once OAR has
ended the login (the caller aborted, the deadline passed, or `onEvent`
threw), it refuses the save, and OAR aborts the SDK's signal, which ends its
poll. Whichever comes first decides: a save that has begun stands, and a
later abort or deadline waits for it and yields `logged_in`; an end that
came first makes `cancelled` or `timed_out` mean that `auth.json` was not
written. A stop that lands after the browser sign-in but before the save
leaves the minted key unsaved yet listed in the dashboard until it expires or
is revoked there; the SDK cannot revoke it. A minting already under way
finishes in the background, and its save is refused. OAR's deadline is 15
minutes, before the SDK gives up on its own. A rejection from the SDK is
`rejected` with the first line of its message, redacted: a poll that failed
or ran out, a refused key (`Login succeeded, but creating an SDK API key
failed: …`, for instance when a team restricts user API keys), or a save that
failed. A login the SDK resolves is confirmed with `Cursor.auth.status`,
whose `email` and expiry (`expiresAt`, from `apiKeyExpiresAtMs`) are the
account; a status that reads logged out is `not_logged_in`.

`CURSOR_API_KEY` comes first: the SDK uses it before the stored login for
every call (an explicit key, then the variable, then the stored key), and
`status()` ignores it. OAR does not guess: `authStatus` reports the stored
login only, and a login started while the variable is set adds an `info`
event saying that the variable wins until it is unset; its value is never
read. A key stored against another backend (`CURSOR_BACKEND_URL`) also reads
`logged-in`, though the SDK uses it only against that backend. The SDK's own
warning when a backend has no `POST /auth/poll` (it falls back to `GET`) goes
to the host's stderr, out of OAR's reach; it names the backend, not the
verifier.

The floor is `@cursor/sdk` 1.0.37, the exact peer dependency. An SDK handed
over without `Cursor.auth` and `FileCredentialStore` makes the login
`unsupported` / `version_unsupported` and the status `unknown`; an
installation other than `bundled` is `unsupported_installation`, and an SDK
that fails to load `process_failed`. Verified against a stand-in SDK that
runs the 1.0.35 order: URL relayed, success with the account, a cancel while
polling and while minting, the deadline, a stop while the key is saved, the
SDK's failures, an unconfirmed success, a failing `onEvent`,
`CURSOR_API_KEY`, and the status
([login tests](../../tests/login/cursor-login.test.ts),
[status tests](../../tests/login/cursor-auth-status.test.ts)), and with the
real SDK against a local mock of the backend
([`experiments/cursor-login/probe.ts`](../../experiments/cursor-login/README.md),
2026-10-06, 1.0.35 and 1.0.36: a success, and a cancel and a deadline both while it
polls and while it mints, each in an empty home and over a previous login;
the SDK stopped polling on its signal, minted and asked `GetMe` after a
cancel, then saved only through OAR's store, which refused it, so
`auth.json` stayed absent or byte for byte as it was). **Run that experiment
on every `@cursor/sdk` upgrade**: it needs no account and fails if the SDK
writes `auth.json` outside the store it is given. On a real login, on
2026-10-06 and 2026-10-07, on a fresh Linux test machine with `@cursor/sdk`
1.0.36, the four manual checklist steps of
[#146](https://github.com/botiverse/oar/pull/146) (commit `d6ece22`) passed:
the status read (logged out, no `auth.json`); a cancel while it polled
(`login cancelled`) and the deadline (`timed_out`), neither writing
`auth.json` nor leaving a process behind; and a login whose URL was opened on
another device, which ended on its own once signed in (exit 0, the account's
email and a key expiring 90 days later).
[Login](../../packages/oar/src/runtimes/cursor/login.ts),
[status](../../packages/oar/src/runtimes/cursor/auth-status.ts).

### Logout

**Mapped** ([runtime logout](../spec/login.md#logout)): `logout` is the SDK's
own `Cursor.auth.logout()`, called with no options so that it clears the
SDK's own default store, and `Cursor.auth.status` decides. Its signature
[`dist/esm/stubs.d.ts` and `dist/esm/auth/login.d.ts`, 1.0.36; 1.0.35 has
the same] is `logout(options?: SdkLogoutOptions): Promise<void>`, with
`SdkLogoutOptions { store?: SdkCredentialStore }`. Native behavior [bundle
1.0.36]: `(options.store ?? new FileCredentialStore()).clear()`, which is
`rm(~/.cursor/sdk/auth.json, { force: true })` (a missing file is no error),
then it drops its in-process cache of the stored key. It makes no request.

**The minted key is not revoked.** It stays valid, listed among the
dashboard's API keys as `Cursor SDK login (<hostname>)`, until it expires
(90 days after the login) or someone revokes it there. The SDK has no call
that revokes it; its own declaration says "Local-only: the minted key stays
valid until its expiry unless revoked from the dashboard's API-keys page." A
host that wants the key dead must send the person to the dashboard.

`CURSOR_API_KEY` is not touched, and since `Cursor.auth.status` ignores it,
a logout with it set is `logged_out` while every SDK call goes on using the
variable. A throw is `rejected` with its first line, redacted. The deadline
is 20 s; the removal is local and OAR cannot stop it, so past the deadline
OAR stops waiting (`timed_out`, unless the status already reads logged out).
An SDK handed over without `Cursor.auth.logout` makes the logout
`unsupported` / `version_unsupported`. Verified against the stand-in SDK
([tests](../../tests/login/cursor-logout.test.ts)), and with the real SDK in
temporary homes
([`experiments/cursor-login/probe.ts`](../../experiments/cursor-login/README.md),
2026-10-07, 1.0.36): a logout over a previous login removed `auth.json` and
read logged out, a second one was `logged_out` too, `CURSOR_API_KEY` was
left as it was, nothing was printed and no request was made. The real-login
checklist of [#192](https://github.com/botiverse/oar/issues/192) is not run
yet. [Logout](../../packages/oar/src/runtimes/cursor/logout.ts).

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

Open gaps: a crew child (no environment); tool calls the SDK runs without
updates; the cloud runtime; Windows and macOS live runs, the login's
included; `mcpServers`, refused until a live run shows what
[session MCP servers](#session-mcp-servers) lists (the stand-in backend
measurement is not in the repo and not repeatable from it).
Keep native API capabilities, SDK limitations, OAR omissions and unexecuted
checks separate when designing or claiming support.

## Disallowed tools

`SessionOptions.disallowedTools` goes unchanged to native
`Agent.create` / `Agent.resume` as `disallowedTools`. SDK 1.0.36 accepts its
local tool names and raw protobuf names. `shell` excludes both shell and
shell-stdin calls; `mcp` excludes the entire MCP tool/resource/auth family,
including custom callback tools. An individual `mcp__server__tool` is not a
supported selector: native name validation is surfaced as
`UnsupportedOptionError` on `disallowedTools`, preserving the named entries.
The SDK does not persist the option; supply it again on resume.

The filter applies to the main agent. Native Task children have a separate
curated toolset; include `task` when the host must prevent delegation. OAR
does not install subagent inheritance overrides or normalize tool names.

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).
