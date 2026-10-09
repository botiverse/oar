# OpenCode

Independent inventories: not implemented for OpenCode yet.
See the [query contract](../spec/inventory.md) and [native probe evidence](inventory.md).

The installed executable selects the adapter behavior: v1 (`opencode-ai`)
and v2 (`@opencode/cli`) share the `opencode` runtime ID. OAR preserves the
reported version string, including v2's `opencode v2.0.26` prefix. Updating
within a line and migrating to another line are separate user decisions.
The sections below describe v1 unless they explicitly name v2.

Evidence baseline: **opencode 1.18.30** (linux x64, `opencode acp`, the free
model `opencode/big-pickle` with no login) on 2026-10-06 through
[`experiments/live-contract.ts opencode`](../../experiments/live-contract.ts)
(13/13, scenario names in parentheses below), the
[vendor snapshot](../../tests/replay/fixtures/opencode-acp-v1.vendor.json)
from [`experiments/acp-vendor-snapshot.ts`](../../experiments/acp-vendor-snapshot.ts),
and direct ACP probes of the same binary for model switching, effort and
resume. Source was read at **v1.18.34** (`anomalyco/opencode`,
`packages/opencode/src/acp/`, `session/prompt.ts`); where only the source
says so, the statement is marked [src]. The
[HTTP server section](#the-http-server-investigated-2026-09-12) is the
earlier investigation of the same version through `opencode serve`.
Versions are evidence baselines, not a support range; see the
[runtime index](README.md) for status conventions.

The same 13 live scenarios passed on **1.18.35** on 2026-10-07
(Linux x64, Node 24.19.0, `opencode/big-pickle`), without adapter changes.
The native prompt-options probe and all three MCP vendor tests also passed,
including both prompts combined with session MCP servers. This adds current
ACP session evidence; it does not repeat the separate HTTP-server
investigation or the direct model-switching probes. See the
[October 7 report](../../experiments/runtime-version-checks/2026-10-07.md).

## OpenCode v2

The v2 adapter follows `@opencode/cli` **2.0.26**. Its ACP subprocess owns a
standalone native server; OAR does not connect to or leave a persistent
daemon. [Boundary probe](../../experiments/opencode-release-lines.ts) and
[October 9 evidence](../../experiments/opencode-v2-2026-10-09.md) distinguish
native observations from source-only findings.

- **Control:** v2 refuses a concurrent `session/prompt`. The session has no
  `steer` member; `steerOrQueue` and `deliver` queue the input for another
  turn. Queueing remains an OAR memory FIFO, not durable native storage.
  Native abort and disposal during a shell call both ended as `aborted`.
- **Children:** standard updates arrive on the parent's envelope with
  `update._meta["opencode/child-session"]` (`id`, `parentID`, `depth`,
  `title`). OAR records them under the named child session, links its real
  parent in the graph and declares `nested` attribution. Child text, tools
  and usage do not become root output. Native notifications remain
  verbatim. The native tool `name` wins over its display title, so a
  child's `shell` stays `shell` even when its title has a child prefix.
- **Tool names:** `shell` is a command with its reported `command` input;
  v1 `bash` remains supported. `subagent` and Code Mode `execute` retain
  their names and classify as `other`. `execute` can run MCP calls, ordinary
  JavaScript or `fetch`; the name alone cannot prove an MCP operation.
- **MCP:** stdio servers supplied at new and resumed session open were
  callable through `execute`. Its input code, result and native metadata
  are retained, including the names of the enclosed MCP calls.
- **Prompt options:** both `systemPrompt` and `appendSystemPrompt` are
  refused before ACP startup, including resume. The v2 instruction loader
  does not consume the v1 `instructions` configuration. v2 has native
  `agents.<id>.system`, but OAR has not verified a safe session-local path
  that resolves the actual agent on both creation and resume. This is an
  adapter boundary, not a claim that v2 lacks system prompts. Configure
  v2's native settings directly when those settings are intended.
- **Models:** queries use `models --standalone`, never `--verbose` or a
  persistent service. On 2.0.26 it exits before the cold catalog is ready;
  an empty native response becomes `unsupported` with
  [upstream issue #53724](https://github.com/anomalyco/opencode/issues/53724),
  not `ok` with zero models. OAR creates no throwaway session for a read-only
  query. A nonempty native listing supplies IDs only; no effort menu is
  fabricated. Once upstream returns a ready catalog, this normal path can
  use it. An isolated `api agent.list --standalone` also returned `[]`.
- **Defaults and configuration:** the native default model was
  `opencode/exo-free`, and the initial effort was `default`; these are
  observations, not OAR defaults. v2 can rewrite v1's `autoupdate` config
  into `update` on its first launch. OAR does not migrate or rewrite that
  user configuration. Explicit model selection still uses native readback.
- **Interaction limits:** no elicitation capability is advertised. v2's
  question path remains outside the verified host-answer contract.

## Image-only input

OAR sends ACP image blocks without a text block when `input` is `""`.
OpenCode 1.18.35 delivers the image to a local scripted Anthropic provider
without an empty text block ([image-only provider test](../../sea-trial/vendor/image-only.vendor.test.ts)). The selected model must advertise
image input in `modalities.input`; a text-only model receives OpenCode's
"Cannot read" notice instead of the image. Its separate title-generation
request may add a title prompt beside the same image.

## Native concepts and calling interfaces

| Shape | Command | Protocol |
|---|---|---|
| HTTP server | `opencode serve` | REST + OpenAPI 3.1 self-description (`/doc`), SSE event stream |
| ACP server | `opencode acp` | Agent Client Protocol over stdio |
| Client | `opencode attach <url>` | Connects to someone else's server |
| One-shot | `opencode run` | Single turn |

The object hierarchy is `project` → `workspace` → `session`:

- `project` is a git worktree; its id is a hash (`/tmp/faye-oc/repo` →
  `5eb21528…`). **Every non-git directory collapses into one synthetic project
  `global`, with worktree recorded as `/`**, so on one machine all
  non-repository directories share one project.
- `workspace` (`wrk_` prefix) is a git worktree materialised under
  `~/.local/share/opencode/worktree/<projectID>/<slug>`.
- `session` (`ses_` prefix) carries three attribution columns: `project_id`,
  `workspace_id`, `parent_id`.

A session runs one agent loop at a time. A prompt is admitted as a user
message and the loop runs model steps until the last assistant message
finishes without tool calls; each step re-reads the messages, so a user
message admitted while the loop runs is part of the next step
(`session/prompt.ts` `runLoop`, [src]). A `task` subagent runs in a child
session (`parent_id`).

OAR uses `opencode acp`. It is opencode's own ACP layer, built as a client of
its own HTTP server API (`acp/service.ts` calls `sdk.session.prompt`,
`sdk.session.list` and so on, [src]), so the mapping onto ACP is upstream's.
`@opencode-ai/sdk` (1.18.34 on npm) is the generated client for that HTTP
API, and its `createOpencode()` starts `opencode serve` as a child process;
it is not an in-process SDK. The in-process host `@opencode-ai/sdk-next` is a
private workspace package and is not published. Driving the HTTP server
directly would mean a new adapter for an API in the middle of a v1 to v2
migration; it becomes worth it if child-session events or attaching to a
server the user already runs are needed.

## High-level mapping to OAR

OAR exposes one ordered record stream per Session
([contract](../../packages/oar/src/contracts/session.ts)). Every ACP frame is
recorded verbatim as a frame's `native`; the cross-runtime `events` are what
OAR reads out of it. Control calls are request/response record pairs.

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `opencode acp` executable | One `opencode acp` subprocess per OAR Session, spawned in the session `cwd` with the env overlay (`null` removes an inherited variable, [contract](../spec/runtime-matrix.md#session-environment)); its exit is an `exited` response record (kill-runtime). |
| Persistent native session | `Session.id` is the native `ses_` id; `SessionOptions.resume` attaches through `session/resume`, which replays nothing (resume). |
| Handshake answers and opening pushes | Answers are frame records with `model` and `effort` events where they report them; no `authenticate` is sent. |
| Native agent and turn | Every `session/update` is one frame with `native` verbatim. No `spanId`. Attribution tier `opaque`: a `task` subagent's child session never reaches the transport, so only the parent's tool call shows (subagent). |
| Prompt, steer, queue and cancel | A turn is one `session/prompt` RPC, its answer carrying `turn_ended`. `steer()` is a second `session/prompt` while one runs; it joins the running loop and both answers close the one turn (steer). `queue()` is a host-memory FIFO; `abort()` is `session/cancel` with a kill fallback (abort). |
| Typed events, history and child graph | Events for message, reasoning, tool, usage and model updates; unknown kinds are recorded with no events. The graph is the root session only. |
| Client execution and interaction duties | opencode runs its own tools and asks for no terminal. A `session/request_permission` arrives only for what opencode's permission rules ask about; OAR allows it like every ACP request. The `question` tool is off for ACP clients ([src] `tool/registry.ts`). |

Sources: [OpenCode profile](../../packages/oar/src/runtimes/opencode/session.ts),
[ACP opening path](../../packages/oar/src/shared/acp/profile.ts),
[session controller](../../packages/oar/src/shared/acp/session.ts),
[turn machinery](../../packages/oar/src/shared/acp/turns.ts),
[event projection](../../packages/oar/src/shared/acp/projection.ts).

## Capability details

### Session creation and resume

`initialize` advertises `loadSession`, `sessionCapabilities` `close`, `fork`,
`list` and `resume`, and image prompts. The one auth method,
`opencode-login`, answers `{}` and changes nothing; credentials come from
`opencode auth login` or provider environment variables, and the `opencode/*`
free models need none. `session/new` answers the `model` and `mode` config
options, plus `effort` when the model has variants.

A resume naming another directory runs in the session's own: a session
created in A and resumed with `cwd` B printed A for `pwd`, transcript intact.
OAR reads the session's directory from `session/list` and refuses the resume
with `UnsupportedOptionError` on `cwd` ([resume in another
directory](resume-cwd.md)). Every non-git directory belongs to the one
`global` project, yet `session/list` without a directory still found a
session from a non-git directory when the resume named a git repository.

### Interrupted input

On 1.18.35, steering followed immediately by `session/cancel` kept the
steering text in the next prompt's provider request. An aborted prompt does
not prove discard, so OAR emits no `input_dropped` for it. ACP provides no
verified input-ID echo; inputs still enter the view at their request.
[Native scripted-provider probe](../../experiments/input-interruption-2026-10-08.md).

### Prompt, steering, queueing, and abort

A `session/prompt` sent while one runs is not refused: opencode admits it and
the running loop reads it at its next step. Both prompt RPCs are answered
when the session goes idle, each after a `usage_update`
([src] `acp/service.ts` `runUntilIdle`). Live, a steer sent mid-turn landed
in the same turn's final reply (steer: "ALPHA BRAVO MANGO"). OAR therefore
gives the session a `steer` with no extra prompt parameters, and the turn
ends once, on the original prompt answer. Both native answers remain
recorded. If a steering RPC later refuses, its error frame reports
`input_dropped {inputId, reason: "runtime_refused"}`; the active turn keeps
its own outcome. Acceptance stays immediate rather than blocking until
OpenCode becomes idle.

`session/cancel` aborts the loop; the prompt answers `cancelled` about 0.1 s
later, the running shell call is closed, and the turn ends `aborted` (abort).
After an abort the `usage_update` reports `used: 0`, since it reads the
latest assistant message, which the abort left empty.

OAR owns the ACP process. An exit ending a running turn after its accepted
abort or dispose request is read as `aborted` by the folds; an unrequested
exit is `failed: runtime_exited`. A native turn end that arrives first keeps
its outcome, and the exit code stays on `exited`.
Disposal and the ten-second abort fallback end its
process group on POSIX (SIGTERM, then SIGKILL after the configured grace;
the SIGKILL, or the runtime's exit if that comes first, also takes its
descendants that left the group, as for
[claude](claude.md#process-ownership-environment-installation-and-account-usage)),
or its process tree on Windows (`taskkill /T /F`, including a launcher and
the runtime behind it). The [dispose regression](../../tests/session-dispose.test.ts)
checks both runtime and descendant termination. See
[host-exit cleanup and limits](../spec/record-stream.md#the-rules).

### Observation, children, and history

Text, reasoning (`agent_thought_chunk`), tool calls and `usage_update` arrive
as `session/update`. A tool call's opening `tool_call` carries its name as
`title` and no arguments: a shell call has `title` `bash`, `kind` `execute`
and `rawInput` `{cwd}` only, and the file tools (`write`, `read`, `edit`,
`grep`, `glob`) an empty `rawInput`. The arguments arrive on the next
`tool_call_update` (tool-detail): `bash` `{command, cwd}` or
`{command, workdir}`, retitled with the command; `read` `{filePath}`;
`write` `{content, filePath}`; `edit` `{filePath, oldString, newString}`;
`grep` and `glob` `{path, pattern}`. OAR reads that update as a
`tool_call_input` with the whole input (a further update repeating them
adds none), and the session view's tool part takes it, so
`classifyTool` reads `bash` as `run_command` with its `command`, `read` as
`read_file`, `write` and `edit` as `edit_file` and `grep` and `glob` as
`search`, each file tool with its `filePath` or `path` as the detail
(`read`, `write` and `edit` also give that one path as `paths`)
([recordings](../../tests/replay/fixtures/opencode-acp-v1-files.vendor.json),
[test](../../tests/replay/tool-activity.test.ts)). No recorded `bash` input
has a `description`. The closing update carries the output in `content` and
`rawOutput` `{metadata, output}`, and retitles the call (`write`, `read`
and `edit` with the file path, `grep` with the pattern, `glob` with the
directory).

The prompt answer's `usage` field is the last assistant message's tokens
only, not the turn's, so OAR does not report token totals (and so no
`cacheRead` or `cacheWrite`); context usage comes from `usage_update`
(`used`, `size`, `cost`).

A `task` subagent completed and its result reached the parent (subagent:
`CHILD-OK-7731`), but no frame of the child session arrived: opencode's ACP
layer forwards parts only for sessions it opened ([src] `acp/event.ts`).

### Service tiers

`SessionOptions.serviceTier` is explicitly refused with
`UnsupportedOptionError`, declared in `Runtime.refusedSessionOptions`.
No per-session native setting plus applied-state readback has been verified
for this adapter; `listModels` therefore advertises no service tiers. OAR
does not silently ignore a requested tier or alter a global default.

### Models, effort, instructions, and context

Model ids are `provider/model` (`opencode/big-pickle`). `session/set_model`
answers `{}` and 1.18.30 pushes nothing, although the switch applies, so OAR
switches with `session/set_config_option` on `model`, whose answer lists
every option with its current value. `listModels` reads
`opencode models --verbose` (every configured provider's models, with each
model's `variants`).

Effort is the `effort` option in the `thought_level` category, present only
for a model with variants; its values are the variant names
(`low`/`high`/`max` on `opencode/fledge-alpha-free`). Because the menu
belongs to the model, OAR reads it from the model switch's answer when a
model was requested; on a model without variants `effort` is refused with
`UnsupportedOptionError`. An unknown model fails the open with the agent's
`Invalid params: model not found` (bad-model).

ACP has no direct prompt field, but the native launcher reads
`OPENCODE_CONFIG_CONTENT`. OAR uses a fresh inline configuration for the
session: `systemPrompt` overrides only the selected `agent.<name>.prompt`;
`appendSystemPrompt` adds one session-owned file to `instructions`. Native
config merging appends that file **after existing instructions**, preserving
other agents, model choices, tools and permission rules. Environment/context,
project instructions and skills that OpenCode adds separately still apply.
The file stays available for later turns and compaction and is removed on
failed open, disposal or process exit. OAR does not rewrite user config or
redirect the runtime's native home.

Before a replacement, OAR runs the selected executable's read-only
`debug config` in the session directory, with the session environment. It
uses `default_agent` (otherwise the native `build` default). For resume,
`export <id> --sanitize` supplies the saved agent, including the historical
message fallback, before consulting that default. No transcript is logged
or used to rebuild the conversation. The ACP open must report that same
mode; otherwise opening fails and names both agents. This also protects
against disabled/renamed defaults and config changes between query and open.
A saved or configured default custom agent missing from resolved config is
refused before injection, so a prompt override cannot recreate a deleted agent
with default permissions. Only the visible built-ins `build` and `plan` may
be absent from that config.
A replacement adds one native startup query, two on resume, each bounded at
30 seconds; no prompt options retains the direct ACP path, and append-only
needs no agent query.

If the effective session environment defines `OPENCODE_CONFIG_CONTENT`,
either prompt option is refused with
`UnsupportedOptionError`. OAR does not parse or merge that existing value.
Setting `env: { OPENCODE_CONFIG_CONTENT: null }` removes an inherited value
before native configuration queries and permits prompt injection.
An empty replacement is also refused: native OpenCode treats an empty agent
prompt as selecting its built-in prompt. Literal `{env:...}` and
`{file:...}` in the supplied prompt are preserved, not expanded by the
native config parser.

[Native request probe](../../experiments/opencode-prompt-options.ts),
**1.18.34**, Linux x64, 2026-10-07: OAR and the real ACP process send requests
to a local scripted provider, without login or model quota. Assertions cover
custom default and customized build agents, both prompt options, earlier
instructions remaining first, resume after the default agent changes,
literal interpolation syntax, unchanged model and denied edit tools,
unchanged config bytes, temporary-file removal, refusal to recreate a deleted agent, and config-env conflicts.
The fixture config includes its `$schema`: OpenCode itself may add that field
to a schema-less file even on the baseline path; an initial isolated probe
observed this native behavior.

Source at [v1.18.34](https://github.com/anomalyco/opencode/tree/v1.18.34):
`config/config.ts` merges inline content and concatenates instructions;
`config/variable.ts` substitutes variables before JSON parsing;
`agent/agent.ts` resolves the default; `acp/service.ts` restores saved agent
selection; `session/llm/request.ts` chooses the agent prompt; and
`session/instruction.ts` reads instruction files again for subsequent requests.

| Session option | Native channel and result |
| --- | --- |
| `cwd` | ACP directory; a resume elsewhere is refused from native `session/list`. |
| `resume` | ACP resume, native session identity and saved agent. |
| `model` | ACP model config option with native read-back. |
| `effort` | ACP `thought_level` config option when the selected model has variants; otherwise refused. |
| `systemPrompt` | Fresh inline `agent.<selected>.prompt`, verified against the ACP mode on new/resumed sessions. |
| `appendSystemPrompt` | Fresh inline `instructions` entry for a session-owned temporary file, on new/resumed sessions. The file goes when the session ends; a host that ends without disposing leaves it to its `exit` event or the next opencode session's sweep ([private-temp](../../packages/oar/src/shared/private-temp.ts)). |
| `env` | Child-process environment, shared by native queries, the ACP process and its tools. |

### Tools, permissions, and process

opencode runs its own tools in its own process tree and asks the client for
no terminal and no file access. It inherits the session's environment, so a
crew child's environment reaches its tools. Installation is the `opencode`
executable on PATH (npm `opencode-ai`, Homebrew, Scoop) or the install
script's `~/.opencode/bin/opencode`, pinned with `OAR_OPENCODE_BIN`.

OpenCode ships two major lines of that one command: OpenCode 1 (npm
`opencode-ai`, 1.x; `--version` prints `1.18.35`) and OpenCode 2 (npm
`@opencode/cli`, 2.x; `opencode v2.0.26`). They do not install side by side:
both scripts write `~/.opencode/bin/opencode`, the 2 installer replaces a 1
binary ([migrating from 1](https://opencode.ai/v2/docs/migrate-v1)) and the 1
script silently replaces a 2 binary
([anomalyco/opencode#54084](https://github.com/anomalyco/opencode/issues/54084)).
So the runtime declares `installLines` `v1` and `v2`, and
[`install`](../../packages/oar/src/runtimes/opencode/install.ts) takes the
host's `line` (none is `line_required`: OAR does not choose) and runs that
line's script when nothing is found: `curl -fsSL https://opencode.ai/install | bash`
([docs](https://opencode.ai/docs/#install)) or
`curl -fsSL https://opencode.ai/v2/install | bash`
([v2 docs](https://opencode.ai/v2/docs/)), macOS and Linux. A copy of either
line already found is `already_installed` with its `line`, never replaced.
Those scripts because each line's `opencode upgrade` takes its script install
as the `curl` method and stays on the line ([runtime install](../spec/install.md),
[sandbox run](install.md)). `opencode upgrade` exists but OAR does not drive
it yet, and there is no account usage query.

### Session MCP servers

`SessionOptions.mcpServers` is ACP's `mcpServers` on `session/new`,
`session/load` and `session/resume`, in ACP's `McpServer` shape (stdio
`{name, command, args, env}`, http `{type: "http", name, url, headers}`,
`env` and `headers` as `{name, value}` lists; `args`, `env` and `headers`
always sent, empty when absent;
[mapping](../../packages/oar/src/shared/acp/mcp-servers.ts),
[test](../../tests/acp/acp-session-mcp-servers.test.ts)). opencode declares
`mcpCapabilities` http and sse, so http entries are sent (to an agent that
declares no http, OAR refuses one with `UnsupportedOptionError`). An empty
or repeated name fails the open before opencode starts. Measured on
opencode 1.18.30 against a scripted provider: an isolated `HOME` and XDG
dirs, provider
`aimock` on opencode's bundled `@ai-sdk/anthropic` in
`$XDG_CONFIG_HOME/opencode/opencode.json`
([vendor test](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts),
[harness](../../sea-trial/harness/aimock-acp.ts)):

- Both transports attach and the model is offered each tool as
  `<server>_<tool>` (`echo_echo`, `remote_echo`), which is also the ACP
  `tool_call` title. The tool result reached the provider as the server
  wrote it, so the server ran with the entry's `env` (stdio) or `headers`
  (http).
- [src] at v1.18.30, `acp/service.ts` hands every entry on new, load, resume
  and fork to `sdk.mcp.add({directory, name, config})`: stdio becomes
  `{type: "local", command: [command, ...args], environment}`, http
  `{type: "remote", url, headers}` (streamable HTTP, then SSE). Errors are
  ignored, so a server that fails to attach fails silently. The servers are
  held in memory by that opencode process, which OAR starts once per session.
- A resume remembers none: resumed with the option, the servers attach
  again; resumed without it, neither tool is offered.
- On a name clash the session's `echo` replaces the user's `mcp.echo` for
  that process, and the user's `userecho` is still called (answering with
  the user's credential). Probed, not in
  the test: a session `echo` whose command is broken still opens, and removes
  the user's working `echo` too (opencode closes and deletes the same-name
  client on failure).

- With `systemPrompt` or `appendSystemPrompt` the session opens through the
  prompt path ([prompts](#models-effort-instructions-and-context)): the
  prompts travel in `OPENCODE_CONFIG_CONTENT` and the servers in the same
  ACP open as above. Measured with both prompts and both servers in one
  session: every agent request carried both prompts and both echoes arrived
  ([vendor test](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts);
  the open's wiring in
  [prompt-cleanup](../../tests/opencode/prompt-cleanup.test.ts)).

The credentials reach opencode only in the open request's params, which OAR
does not record (it records the answers and every `session/update`). A probe
found none in any ACP answer, notification or stderr line, nor under
opencode's directories; the vendor test asserts no record holds one. A failed
open's error message and stack are redacted (`[redacted]`).

## Verification and open gaps

- Only free `opencode/*` models were run; a logged-in provider and its
  permission prompts were not.
- Steer timing against a long tool call was not measured: the steer joins at
  the next model step, so it waits for a running tool to finish.
- The HTTP server would carry child sessions and a replayable event cursor;
  not integrated.
- No update check or upgrade, no inventories.
- [Session MCP servers](#session-mcp-servers) ran against a scripted
  provider only, not a logged-in provider or a free `opencode/*` model. The
  vendor test runs locally (`OAR_TEST=opencode-aimock`), not in CI, which has
  no ACP aimock backend. The broken-command clash was probed, not tested.

## The HTTP server, investigated 2026-09-12

Evidence baseline for this section: opencode 1.18.30 (`~/.opencode/bin/opencode`),
Linux x86_64, probed 2026-09-12 before OAR had an adapter. Headless servers ran
as `opencode serve --port 4610/4611/4612`; the machine-readable contract is
`GET /doc` (OpenAPI 3.1, 162 paths); every conclusion was cross-checked against
the rows in `~/.local/share/opencode/opencode.db`.

### Storage: event sourcing and mutable projections in one database

One SQLite file, `~/.local/share/opencode/opencode.db`, holds 20 tables:
`account`, `account_state`, `control_account`, `credential`, `data_migration`,
`event`, `event_sequence`, `message`, `migration`, `part`, `permission`,
`project`, `project_directory`, `session`, `session_context_epoch`,
`session_input`, `session_message`, `session_share`, `todo`, `workspace`.

The structure that matters: `event` (an immutable stream keyed by
`aggregate_id` + `seq`) plus `event_sequence` (a per-aggregate cursor carrying
an explicit **`owner_id`** column) plus mutable projection tables (`session`,
`message`, `part`, …). The projection can be rewritten while the events stay
fixed.

### Events and projections disagree, and it is the projection that moves

A session created through the `global` project's server, with
`directory=/tmp/faye-oc/repo`, still carries `"projectID": "global"` in its
immutable seq-0 event. After another server claimed that directory as a git
project, the `session` **row** was retroactively rewritten to `5eb21528…`.
Reading only the projection suggests the session always belonged to that
project; reading only the log suggests it never moved.

### Event model: two naming layers, only the persistent one is versioned

- **Bus / HTTP layer: roughly 60 event names, none versioned.** Examples:
  `agent.cycle`, `catalog.updated`, `permission.asked`, `permission.replied`,
  `question.asked`, `pty.created/deleted/exited/updated`, `mcp.tools.changed`,
  `plugin.added`, `session.idle`, `session.error`, `message.part.delta`,
  `session.next.compaction.delta`, `session.next.reasoning.delta`,
  `server.connected`, `global.disposed`, `project.directories.updated`.
- **Persistence / sync layer: 35 types, all suffixed `.N`.** 33 are at `.1`;
  only `session.next.step.ended.2` and `session.next.step.failed.2` are at
  `.2`.

Transient broadcast and replayable persistent events are two contracts, and
only the second promises version evolution. Of the four harnesses surveyed,
opencode alone versions events explicitly.

`/sync/history` cursor semantics: the request body is
`{<aggregateID>: <last seen seq>}` and the response returns events **strictly
greater than** that seq for the named aggregate; **any aggregate not listed is
returned in full from seq 0.** Posting `{"ses_f6ba40976f…":1}` returned only
seq 2 and 3 for that session while five other aggregates came back whole,
consistent with the documented behaviour.

### `/sync/steal` is workspace re-homing, not control preemption

```
POST /sync/steal?workspace=wrk_09460c96a0019dGVNJB3IhqUWP
     {"sessionID":"ses_f6ba40976ffeOGfLJoyWTDRJd4"}
→   {"sessionID":"ses_f6ba40976ffeOGfLJoyWTDRJd4"}
```

The query parameter names the target, the body names the session; omitting
`?workspace=` or passing it empty is a `{"_tag":"BadRequest"}`. Database state
before and after:

| | before | after |
|---|---|---|
| `session.workspace_id` | empty | `wrk_0946…` |
| `event_sequence.owner_id` | empty | `wrk_0946…` |
| appended `event` | none | one `session.updated.1` per call |

It emits `session.updated.1`, **not** `session.next.moved.1`; do not conflate
the two. It is **idempotent in state but not in events**: repeated calls leave
the state unchanged while the event stream keeps growing.

**"Current workspace" is declared per request by the client, not held as
server state.** The same steal succeeded from a server started at the
repository root (4611) and from one started inside the worktree (4612); the
server's cwd does not participate.

### `/sync/replay` rebuilds a session from its events, and identity is client-declared

1. Replaying a session's own 4 events verbatim (with `?workspace=`) returns
   **the same** sessionID, which alone cannot distinguish rebuild from no-op.
2. After `DELETE /session/<id>` (session row and event rows both go to zero),
   replaying its seq-0 event **fully rebuilds** the session: id, slug and
   directory all return. Replay is recovery from the log.
3. Rewriting `aggregateID` / `sessionID` / the event `id` in the payload to a
   fresh `ses_` returns the new id and produces **an entirely new session**:
   same slug, same directory, a clone.
4. Posting the same payload twice leaves a single seq-0 row: **event-level
   idempotent** (the opposite of `steal`).

So on `/sync/replay` **the client supplies the restored sessionID inside the
event**; this does not establish how normal session creation mints IDs.
`?workspace=` only sets `event_sequence.owner_id`; the session row's
`workspace_id` / `project_id` / `directory` are restored from the event
payload, never from the query parameter. Moving a session to another machine
or workspace is therefore protocol-feasible, at the cost of session identity
having no server-side authority: whoever can write events can declare
identity. On this machine the server ran unauthenticated by default
(`OPENCODE_SERVER_PASSWORD` unset).

Two API traps: `/sync/history` returns `aggregate_id` (snake_case) while
`/sync/replay` requires `aggregateID` (camelCase), so a round-trip must rename
the field; and a replay missing `?workspace=` reports `500 UnknownError` with an
`err_<id>` reference rather than `400`.

### Where `parent_id` comes from

- **Only** `POST /session {"parentID":"ses_…"}` writes `parent_id`; it appears
  in `/children` immediately.
- **Fork does not write `parent_id`**: after a fork, `/children` returns `[]`,
  while `/children`'s own documentation describes "child sessions that were
  **forked** from the specified parent". Documentation and implementation
  disagree.
- `POST /api/session` is a second session-creation endpoint whose schema has no
  `parentID`. Passing it neither errors nor takes effect, despite the schema
  declaring `additionalProperties: false`: unknown fields are silently
  swallowed.
- Related schema surface: `subagent`, `subagent_depth`,
  `/experimental/session/{id}/background`.

### Attribution compared with the other samples

- **Claude Code**: runtime process identity `(pidDomain, pid, procStart)` plus a
  peer socket registry. Attribution is bound to a **living process**.
- **Codex**: `installation_id` plus `[projects."<absolute path>"].trust_level`.
  Attribution is bound to a **disk path**.
- **opencode**: workspace scope, rewritable by events, with a literal `owner_id`
  column on the event stream. Attribution is **first-class, movable data**.

### Addressability, resumability floor, and resume material

In the vocabulary shared across the samples:

| Property | opencode |
|---|---|
| identity authority | client-declared on `/sync/replay`; normal creation authority not established by this probe |
| uniqueness scope | globally unique only if clients do not collide; `event_sequence.owner_id` is workspace scoped |
| connection identity, by on-wire addressability | none; HTTP and SSE carry no connection id, and even "current workspace" is declared per request via `?workspace=` |
| resumability floor | event-stream seq 0; deleting the session and replaying its seq-0 event rebuilds id, slug and directory in full |
| history paging cursor | `/sync/history` with a per-aggregate last-seen seq |
| live stream resume cursor | none on the bus itself; the difference can be filled in afterwards from `/sync/history` |
| runtime side resume material | the immutable `event` table |
| broadcast and subscription separated | separated by versioning, not by tier: the transient bus is unversioned, the 35 persistent sync types are all `.N` |
| death boundary | not observed |

"Runtime side resume material" is material the runtime feeds back to the
model; replay is what a host offers its own subscribers. The two words should
not be mixed.

### Design input for OAR

- **A log and a projection are two truths, and reading one is not reading the
  other.** opencode keeps both in one database and lets the projection be
  rewritten under a fixed log. Any host that consumes a runtime's stored state
  has to say which of the two it read.
- **Identity written by the client has no server authority.** Because a session
  id arrives inside the replayed event, whoever can write events can declare
  identity. That makes cross-machine session movement feasible here, and it is
  why a host cannot inherit the runtime's identity as its own: OAR's lineage
  has to record the requests OAR itself issued.
- **Versioning only the persistent layer is a deliberate, copyable split.**
  Transient broadcast (~60 unversioned bus names) and replayable record (35
  `.N` types) are different contracts, and only the second needs to promise
  evolution.

### Server investigation gaps

- **Blocked, not explained.** `POST /experimental/workspace {"type":"worktree"}`
  returns `{"name":"WorkspaceCreateError","data":{"message":"Timed out waiting
  for global event"}}` **while the database row and the on-disk git worktree are
  both created**. So it is a post-creation wait timeout (most likely on a server
  instance or sync loop inside the new worktree), not a creation failure.
  `GET /experimental/workspace` and `/experimental/workspace/status` still
  return `[]` when the row exists. The server log printed only the
  unset-password warning and the `err_<id>` detail never reaches stdout, so it
  was not localised further.
- Calling create twice leaves **two workspace rows pointing at the same
  directory**. `DELETE /experimental/workspace/{id}` removes the database row,
  the on-disk git worktree and the git registration, but **leaves the
  `project_directory` row pointing at the missing directory**, another
  projection that did not keep up.
- Not probed: `/api/session/{id}/event`, `/event`,
  `/experimental/session/{id}/background`, `/api/pty/*`, `/mcp/*`,
  `/permission`, `project.sandboxes`, `session_context_epoch`.
- No real model turns ran, so message/part write granularity is unmeasured.
- Death boundary not observed: no process was killed mid-turn, so the event
  stream and projections at an abrupt exit are unknown.

## Disallowed tools

`SessionOptions.disallowedTools` is refused before prompt preparation or
launch and declared in `refusedSessionOptions`. OpenCode 1.18.35 has native
global and per-agent permission rules, but a global deny can be overridden
by an agent's allow. Permission names also differ from tool names (for
example, multiple file mutations share `edit`). ACP exposes no session
native tool-name denylist. OAR does not rewrite the user's agent definition
or turn a denylist into a computed allowlist.

Evidence and verification limits: [tool-denial audit](../../experiments/disallowed-tools-2026-10-08.md).

## Launch arguments

`SessionOptions.launchArgs` go after `acp`, on the process the session runs; OAR's helper queries (`opencode agent list`) do not get them. OAR passes them unchecked and never records them; give them again on resume. See [launch arguments](../spec/runtime-matrix.md#launch-arguments).
