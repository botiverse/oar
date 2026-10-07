# OpenCode

Independent inventories: not implemented for OpenCode yet.
See the [query contract](../spec/inventory.md) and [native probe evidence](inventory.md).

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

The same 13 live scenarios passed on **1.18.34** later on 2026-10-06
(Linux x64, Node 24.19.0, `opencode/big-pickle`), without adapter changes.
This adds current ACP session evidence; it does not repeat the separate
HTTP-server investigation or the direct model-switching probes. See the
[October 6 report](../../experiments/runtime-version-checks/2026-10-06.md).

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
| `opencode acp` executable | One `opencode acp` subprocess per OAR Session, spawned in the session `cwd` with the env overlay; its exit is an `exited` response record (kill-runtime). |
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

### Prompt, steering, queueing, and abort

A `session/prompt` sent while one runs is not refused: opencode admits it and
the running loop reads it at its next step. Both prompt RPCs are answered
when the session goes idle, each after a `usage_update`
([src] `acp/service.ts` `runUntilIdle`). Live, a steer sent mid-turn landed
in the same turn's final reply (steer: "ALPHA BRAVO MANGO"). OAR therefore
gives the session a `steer` with no extra prompt parameters, and the turn
ends once, on the last answer.

`session/cancel` aborts the loop; the prompt answers `cancelled` about 0.1 s
later, the running shell call is closed, and the turn ends `aborted` (abort).
After an abort the `usage_update` reports `used: 0`, since it reads the
latest assistant message, which the abort left empty.

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

If the host environment **or** `SessionOptions.env` already defines
`OPENCODE_CONFIG_CONTENT`, either prompt option is refused with
`UnsupportedOptionError`. OAR does not parse or merge that existing value.
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
| `appendSystemPrompt` | Fresh inline `instructions` entry for a session-owned temporary file, on new/resumed sessions. |
| `env` | Child-process environment, shared by native queries, the ACP process and its tools. |

### Tools, permissions, and process

opencode runs its own tools in its own process tree and asks the client for
no terminal and no file access. It inherits the session's environment, so a
crew child's environment reaches its tools. Installation is the `opencode`
executable on PATH (npm `opencode-ai`, Homebrew, Scoop) or the install
script's `~/.opencode/bin/opencode`, pinned with `OAR_OPENCODE_BIN`.
`opencode upgrade` exists but OAR does not drive it yet, and there is no
account usage query.

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
