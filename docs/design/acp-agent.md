# Serving runtimes over ACP

Status: proposal (2026-10-06, revised 2026-10-09), for review before any
code. Asked for in Raft `#new-runtimes:5d69cb37` (messages `993d718d`,
`f263df4f`, `beee6531`, `6b182f38`); host dialects made optional and equal
on the owner's word (`90fefdc8`, `ddee9ce9`, `269039dd`).

ACP clients (Zed, JetBrains AIR, Lody, editor plugins) start an agent
command and speak the Agent Client Protocol to it over stdio. OAR already
drives eight runtimes through one contract. Serving that contract over ACP
lets every ACP client use every OAR runtime, including the ones whose
vendor ships no ACP server (codex app-server, claude stream-json, pi,
cursor), and it lets a host built on OAR offer the same sessions to an
editor.

The bar, from the owner: `oar acp codex` must be at least as good as the
codex ACP adapters, and `oar acp claude` at least as good as
`claude-agent-acp`, judged by OAR's own principles rather than by feature
parity. Each row of the comparison below either holds, improves, names
the OAR change that closes it, or says why OAR declines it.

## Shape

**Library.** `serveAcp(stream, options)` from a new subpath
`@botiverse/oar/acp`. `stream` is the ACP SDK's `Stream` (stdio through
`ndJsonStream`, a WebSocket, an in-memory pair in tests), so the transport
is the caller's. `options` carries the runtime registry (or one runtime),
how to resolve its installation, the approval policy, and an optional
session store (below). It serves any `Runtime`: built-in, community, or a
host's own.

**CLI.** `oar acp <runtime> [--model] [--effort]` is `serveAcp` over stdio
with a store under the user's OAR data directory. Zed and Lody launch it as
a custom agent command; neither needs code changes.

**It is a host, not a contract.** The bridge is written against the public
API only, under the same import rule as community runtimes. Its policy
choices (approval default, persistence, how a model switch is applied)
are its own. Nothing ACP shaped enters `contracts/`. When the bridge finds
a fact it cannot serve, the fix goes into OAR's events for every host, not
into a bridge side channel. This also keeps it apart from the remote
binding of [roadmap](roadmap.md) item 6: ACP has no `seq`, cursor or
native frame, so it cannot be OAR's own wire.

**Protocol version.** ACP v1 is stable; v2 is a draft. Serve v1 now. v2's
prompt lifecycle (a prompt is answered once inserted, progress moves to a
`state_update`) matches OAR better (the prompt request record starts the
turn, `turn_ended` ends it), so add it through the SDK's protocol router
once it stabilizes.

## Mapping

### Requests from the client

| ACP | OAR | Notes |
|---|---|---|
| `initialize` | registry, `Runtime` members | `loadSession` only with a store. `promptCapabilities`: `image` true (a session whose `capabilities.images` is false rejects an image prompt with the reason), `embeddedContext` true (resources are inlined as text, as both reference adapters do), `audio` false. `authMethods` from `Runtime.login`. |
| `authenticate` | `Runtime.login` | `auth_url` and `device_code` events go out as a URL elicitation; claude's `manual_code` prompt as a form elicitation. One flow for every runtime with `login`. |
| `session/new` | `runtime.session(installation, { cwd, model, effort })` | `sessionId` is `Session.id`. `configOptions`: `model` and `effort` (`thought_level`) from `listModels`. `mcpServers` waits on prerequisite 4. |
| `session/prompt` (idle) | `Session.prompt` | Answered at `turn_ended`: `completed` is `end_turn`, `aborted` is `cancelled`, `failed` is a JSON-RPC error whose data carries the `FailureClass` and reason. |
| `session/prompt` (running) | `Session.queue` | A later turn, as in `claude-agent-acp` and Lody's v2 codex. Answered when that spontaneous turn ends. |
| `$/cancel_request` on a queued prompt | `Session.withdraw` | Accepted means the input was never sent, answered `cancelled`. Absent `withdraw` (codex today) leaves it queued, and the request says so. |
| steer in the negotiated host dialect (Lody: `_lody/session/steer`) | `Session.steer` | Offered only when `steer` exists. Lody's form: `injected` on accepted; `_lody/session/steer_applied` when the runtime's `user_message` evidence for that `inputId` arrives. Pure ACP: no steer. |
| `session/cancel` | `Session.abort`, then `withdraw` each held input | Pending permission requests are answered `cancelled`, as ACP requires. |
| `session/set_config_option` (`model`, `effort`) | dispose at a turn boundary, `resume` with the new options | What Ferry does today. Confirmed by the reopened session's `model` / `effort` events, then `config_option_update`. A live `Session.configure` ([roadmap](roadmap.md) item 5) would replace the restart. |
| `session/resume` | `SessionOptions.resume` | No replay, as ACP requires. |
| `session/load`, `session/list` | the bridge's store | See below. |
| `session/close` | `Session.dispose` | |

### Updates to the client

| OAR event | ACP `session/update` |
|---|---|
| `text_delta` | `agent_message_chunk`, `messageId` when the event has one |
| `reasoning` (text) | `agent_thought_chunk`; redacted or empty reasoning sends nothing |
| `tool_call_started` | `tool_call`, status `in_progress`, `kind` from `classifyTool` (`run_command` is `execute`, `read_file` `read`, `edit_file` `edit`, `search` `search`, `web` `fetch`, others `other`), `rawInput` the recorded input |
| `tool_call_progress` | `tool_call_update` with the output as content |
| `tool_call_ended` | `tool_call_update`, status from `result` (`failed` or `completed`), content from the output parts. Where the runtime reported no result, ACP still needs a final status: `completed`, with `_meta.oar.result: "unreported"`. |
| `usage` (context) | `usage_update { used, size }` |
| `model`, `effort` | `config_option_update` |
| `app_request` | `session/request_permission` (prerequisite 1) |
| `exited` | the open prompt fails with `runtime_exited` |
| child records (`agentPath`, child sessions) | the negotiated host dialect's subagent event (Lody: `_lody/subagents/event`), else the parent's tool call only |

Shell output follows Zed's `_meta.terminal_*` display convention when the
client opts in, as both reference adapters do: display only, built from
`tool_call_progress` and `exitCode`.

### History, load and list

[Session history readback](decisions.md#session-history-readback-2026-09-15)
was refused: stored state and the live wire differ, so a readback cannot
honestly be frames. ACP's `session/load` must replay the whole
conversation. The bridge resolves this the way that decision tells hosts
to: it is a host, so it persists the records of every session it serves
(a voyage log), and `session/load` replays those records through the same
mapping. `session/list` lists them. A session the bridge never served (one
started in the vendor's CLI) can be resumed but not loaded. This is also
the decision's reopen condition ("a host whose sessions are created outside
it and that must render them"); if editors need it, the question returns
there, not here.

## Beyond ACP: host dialects

ACP v1 has no steer, no subagent attribution and no per segment usage;
its `SessionUpdate` union is closed, so a new update kind breaks stock
clients. Extra facts must ride in `_meta` or `_`-prefixed methods, and
each host that needs them has defined its own: a host dialect.

In `oar acp` OAR is the guest, so the dialects it speaks are the hosts'.
(The other direction, OAR as the client of an ACP agent, already speaks
each guest's own conventions in that runtime's profile: grok's
`_meta.sendNow`, opencode's prompt-while-running. Those are runtime
integration details, not dialects of this bridge.)

- **Pure ACP by default.** With no dialect negotiated, the bridge speaks
  standard ACP only, and a fact ACP has no place for is not sent.
- **Every dialect optional and equal.** A dialect is one module that maps
  the OAR facts ACP lacks (steer, subagents, usage segments) to that
  host's wire form, with its source and version cited and its own tests.
  None is preferred: the bridge speaks a dialect when the client declares
  it in `initialize` (Lody: `clientCapabilities._meta.lody`), or when the
  host serving the bridge turns it on for a client that cannot declare
  it. Several can be on at once; each fact goes out in every dialect on.
- **Lody's is the first** (`acp-extension-core`, 0.1.x, specs in draft,
  so the module pins each feature's version): each feature is
  `{ version: 1 }` under `agentCapabilities._meta.lody`, absent means
  unsupported; steer is inject or refuse with an applied acknowledgement;
  a subagent run carries its parent tool call; usage totals are
  cumulative within a scope.
- **The ACP RFDs are dialects too** when they stabilize (Subagent
  Sessions, unstable `subagent_update`; End-Turn Token Usage; v2 Prompt
  Lifecycle): a module beside the others, not a replacement.
- Withdraw needs no dialect: ACP's standard `$/cancel_request` is it. No
  `_oar/*` method until a fact has no home in standard ACP or any host's
  dialect.

## Against the reference adapters

References: Zed's `codex-acp` (in process codex-core 0.137, frozen; its
README points to the app-server successor), Lody's `acp-extension-codex`
(a fork of that app-server successor, codex 0.159.2), `claude-agent-acp`
0.86.0 and Lody's fork of it (both on the Claude Agent SDK). Evidence,
with source versions and file and line for each claim:
[codex adapters](../prior-arts/acp-codex-adapters.md),
[claude adapters](../prior-arts/acp-claude-adapters.md),
[Lody's extension and the ACP spec](../prior-arts/acp-lody-extension-and-spec.md).

| Row | codex references | claude references | `oar acp` | Judgment |
|---|---|---|---|---|
| Text streaming | token deltas | token deltas (partial messages) | codex, pi: token deltas; claude: whole blocks | Close in OAR (prerequisite 5) |
| Steer | Lody: `_lody` steer to `turn/steer` | `_session/steering`, Lody `_lody` steer | every runtime with `steer`, one semantics, in each negotiated host dialect | Better: one meaning across runtimes |
| Queue and withdraw | Lody v2 queues in the adapter | queued in Claude Code; 0.86 drops a cancelled one | `queue`; `$/cancel_request` withdraws where `withdraw` exists | Same; codex withdraw closes in OAR (prerequisite 6) |
| Cancel | `turn/interrupt` | `interrupt()` with a 30 s backstop | `abort`; the outcome is the runtime's own `turn_ended`, and `dispose` always settles | Same |
| Approvals and modes | forwarded; 3 or 4 sandbox modes | forwarded; permission modes; always allow persisted by Claude Code | none: OAR runs every runtime with full access | Close in OAR (prerequisite 1); modes declined (below) |
| Plan | from `turn/plan/updated` | from `TodoWrite` | not read | Close in OAR (prerequisite 2) |
| File diffs | per hunk `diff` content | `diff` content for Edit and Write | not read | Close in OAR (prerequisite 3) |
| Client MCP servers | merged into codex config | handed to the CLI | not passed | Close in OAR (prerequisite 4) |
| Subagents | Lody: child threads as `_lody` events or draft child sessions; Zed: none | flattened with `parentToolUseId`, draft child sessions, Lody `_lody` events | `agentPath` and child sessions on every runtime that reports them, in each negotiated host dialect | Better for runtimes the references lack; phase 3 |
| Usage | `usage_update`; Lody per turn and per model | `usage_update` with cost; per model | `usage_update`; token totals | Same; no cost: claude's figure is a client side estimate, which Lody drops too |
| Failures | JSON-RPC error with codex detail | errors and `authRequired` | `FailureClass` on every runtime | Better: one classification |
| Login | browser, API key, Lody device code | terminal login run by the client | `Runtime.login` through elicitation | Same for claude and codex; other runtimes follow `login` |
| Model and effort switch | live, or on the next `turn/start` | live (`setModel`, flag settings) | restart at a turn boundary | Worse in cost until `Session.configure` (roadmap item 5) |
| Load and list | from codex's stores | from the SDK's transcripts | from the bridge's own store | Narrower: only sessions the bridge served (decision above) |
| Fork, delete | Lody: yes | yes | no | Declined until OAR has fork |
| Slash commands | adapter built (`/review`, `/compact`, ...) | the CLI's own list | none | Phase 3 (below) |
| Client fs and terminal | not used | not used | not used | Declined, as both references and ACP v2 do |
| Runtimes | codex | claude | all eight, plus hosts' own | Better |

## Prerequisites in OAR

Each is an OAR change that every host gets, goes through the
[decision gates](decisions.md#decision-gates), and lands in its own PR.

1. **Approvals a host answers.** The draft #26 (`approvals: "ask"`,
   `Session.answer`, typed `AppAsk`) is this. The bridge maps a
   `tool_approval` ask to `session/request_permission` with the runtime's
   own choices, and a `question` ask to a form elicitation. rowrow asked
   for the same thing from a phone.
2. **A `plan` event**, read where the runtime reports a plan: codex
   `turn/plan/updated`, an ACP runtime's `plan` update (kimi sends one,
   which OAR records today with no event). claude's
   `TodoWrite` is a tool call, not a plan report; reading its input stays
   an observe helper like `classifyTool`, which the bridge may use.
3. **File changes as tool output.** A `diff` output part (path, old and new
   text, or a unified patch) where the runtime reports the change: codex
   `fileChange`, ACP `diff` content (kept as `other` today), claude's
   `tool_use_result.structuredPatch` on an Edit result.
4. **Per session MCP servers.** `SessionOptions.mcpServers` through each
   runtime's own channel (claude `--mcp-config`, codex `mcp_servers`
   config, the ACP runtimes' `session/new`). Raft's daemon injects MCP
   servers per session today and needs this to move onto OAR (#oar-raft,
   2026-10-04).
5. **claude streaming text.** `--include-partial-messages`, so `text_delta`
   is token sized on claude too. Ferry and rowrow get smoother text as
   well.
6. **codex withdraw**, through `thread/queue/delete` once live verified.

Phase 1 needs none of them and serves all eight runtimes with full access.

## Declined, and why

- **A shared mode vocabulary.** ACP modes are agent defined; codex's are
  sandbox presets, claude's are permission modes, and the others have
  neither. Under [a runtime's own settings](capabilities.md#a-runtimes-own-settings)
  they stay per runtime: the bridge offers `ask` and full access once
  prerequisite 1 lands, and a runtime's own presets only when a per
  session native setting exists for them.
- **Routing a runtime's file and shell tools through the client.** It
  changes what the runtime's tools do. Neither reference adapter does it,
  and ACP v2 removes the client methods.
- **Stop reasons OAR does not read.** `max_tokens`, `max_turn_requests` and
  `refusal` appear only when an event says so; today none does.
- **Commands the bridge invents.** `available_commands_update` lists a
  runtime's own commands where it reports them (claude's init lists
  them; ACP runtimes send their own update). codex's `/review` and
  `/compact` are app-server methods, so they would be new session
  operations judged on need (compaction exists on claude, codex and pi),
  not bridge commands. Phase 3.

## Acceptance

- **In the repo:** a behavior suite in which an ACP SDK client drives
  `serveAcp` over an in-memory stream against the mock and the claude,
  codex and pi aimock backends, so CI runs it. A case per mapping row:
  prompt and each outcome, queue then withdraw through
  `$/cancel_request`, steer and its applied acknowledgement, cancel with a
  held input, resume, load from the store, a model switch, an exit mid
  turn, and the permission flow once prerequisite 1 lands.
- **Live:** Zed and Lody, each running `oar acp codex` beside the codex
  references and `oar acp claude` beside `claude-agent-acp`, through a
  scripted checklist of the rows above. The result table is recorded with
  versions, like the runtime pages. In Lody the bridge runs as a custom
  agent (`cliType: 'custom'`, `CustomAcpLaunchSpec { command, args }`);
  Lody's source (d23ffd4) probes a custom agent at start and enables by
  its declared `_meta.lody` capabilities: steer (`steering`; the UI button
  needs an authoritative probe), subagent events, session title,
  `forkAtTurn`, fork, goals, form elicitation, and model, mode and effort
  selectors built from `configOptions`. Hard-wired to its builtin agents,
  so not available to `oar acp` in Lody whatever it declares: Edit and
  Resend (builtin Codex and Claude), persisted `_lody` usage and rate
  limits, history import (Codex), provider setup, and Codex's proposed
  plan prompt. Those are Lody's to open, not the bridge's to work around.
- **The bar:** every row same or better, or declined with its reason here.

## Phases

1. `@botiverse/oar/acp` and `oar acp`: the standard v1 mapping, queue,
   withdraw, cancel, the dialect layer with Lody's steer, resume, store
   backed load and list,
   model and effort by restart, `usage_update`, login by elicitation. All
   eight runtimes, full access.
2. Prerequisites 1 to 6, each in OAR with its own record; the bridge maps
   each as it lands.
3. Subagent events, slash commands from a runtime's own list, usage
   segments, and ACP v2.
