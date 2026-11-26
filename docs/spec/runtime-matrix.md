# Runtime matrix, adapter red lines, and the two hard spots

> Part of the [record-stream spec](README.md). Related design pages:
> [hard problems 9-10](../design/hard-problems.md#attribution-the-most-underestimated-part),
> [foundations](../design/foundations.md).

## Per-runtime landing matrix

The **declared tier** column is what each adapter's
`capabilities.attribution` reports; the other columns are native evidence.
The #1/#2/#3 tiers are the attribution spectrum defined in
[attribution.md](attribution.md). The
[runtime programming-interface pages](../runtimes/README.md) hold current
calls, resume semantics, and what each adapter still does not carry.

| runtime | declared tier | how children appear in the stream |
|---|---|---|
| dsh | `nested` | frames of other session ids are child-session records; the parent's durable `subagent/catalog` adds the `tool_call` edge ([mapping](../runtimes/dsh.md#children)) |
| factory | `opaque` | droid runs `Task` sub-agents in child sessions; this adapter records what the root stream carries and links no child sessions yet ([mapping](../runtimes/factory.md#children)) |
| qoder | `attributed` | native parent tool ids use the shared stream-json fold; live nested subagent interleavings remain unverified ([mapping](../runtimes/qoder.md)) |
| qwen | `attributed` | stream-json `parent_tool_use_id` maps to agentPath through the shared fold; live nested subagent interleavings remain unverified ([mapping](../runtimes/qwen.md)) |
| claude | `attributed` | frames with `parent_tool_use_id` carry `agentPath = [...parentPath, taskCallId]`, nested through the Task call's own agent; a child's spend is in the session total, `unattributed`: no frame carries its final usage ([env] 2.1.292) |
| codex (app-server) | `nested` | notifications for other thread ids are child-session records (`sessionId` = the thread); a collab item naming the child adds a `tool_call` edge (`subAgentActivity.agentThreadId`). [env] codex 0.149.0: child-thread notifications arrive on the parent's connection (experiments/codex-child-threads.ts) |
| pi-durable | `opaque` | native `observeConversation` covers one conversation; child conversations are not included in that watch |
| pi | `none` | pi has no native sub-agents; `agentPath` is always root |
| cursor (`@cursor/sdk`) | `attributed` | a child's updates arrive inside the parent's `task` call as `tool-call-delta {callId, taskUpdate}` and carry `agentPath = [...parentPath, taskCallId]` ([env] SDK 1.0.35) |
| grok (ACP) | `nested` | `session/update` for other session ids are child-session records; vendor lifecycle notifications add edges when they name a parent ([sym], unverified live; see [open evidence](#boundaries-and-open-evidence-points)) |
| antigravity (ACP) | `opaque` | legacy `start_subagent` output stays on root ([env] agy_acp_server 1.2.1); native CLI child attribution is unverified. On CLI 1.5.9, a background command completed after `end_turn` without forwarding its completion or later model reply during a 12-second observation ([known gaps](../runtimes/antigravity.md#known-gaps-in-cli-159), upstream [#1461](https://github.com/google-antigravity/antigravity-cli/issues/1461)) |
| codebuddy (ACP) | `opaque` | standard updates and known vendor notifications are retained; no verified child mapping is inferred ([mapping](../runtimes/codebuddy.md)) |
| devin (ACP) | `opaque` | standard ACP updates are retained; no verified child identity mapping is inferred ([mapping](../runtimes/devin.md)) |
| hermes (ACP) | `opaque` | the gateway viewer forwards standard updates; child/subagent identity mapping is unverified ([mapping](../runtimes/hermes.md)) |
| kimi (KAP, `>= 2.7.2-botiverse.1` / `>= 2.7.3`) | `attributed` | subscribes dynamically to child agents on WebSocket and resolves `agent_id` to `agentPath` via `item.agent_refs` or `task.child_agent_id` + `parent_tool_call_id` ([mapping](../runtimes/kimi.md)) |
| kimi (ACP fallback) | `opaque` | `kimi acp` subscribes to the main agent only; the adapter records what arrives and fabricates nothing |
| opencode v1 (ACP) | `opaque` | `opencode acp` forwards only its own sessions' parts; a `task` subagent runs in a child session whose frames never reach the transport, so only the parent's tool call shows ([src] opencode 1.18.34 `acp/event.ts`) |
| opencode v2 (ACP) | `nested` | through 2.2.x, forwarded child updates carry `_meta["opencode/child-session"]`; OAR uses its `id` and `parentID` for the child session and graph edge, retaining the original envelope in `native`. From 2.3.0, OAR declares `opencode/child-session-updates` and reads background children from `opencode/session/child_update`; the edge needs the parent's `subagent` output to name the child ([mapping](../runtimes/opencode.md#v2-session-behavior)) |

| runtime | sub-agent exposure | linkage | per-agent tokens | session graph | resume | evidence |
|---|---|---|---|---|---|---|
| dsh | native child sessions on the process's event channel | `subagent/catalog` (`childId`) on the parent; `subagent/start` alone names no parent | each session's own durable usage; children add through `withChildren` | native parent/child session edges | native id; saved cwd required | [native/current mapping](../runtimes/dsh.md) |
| factory | `Task` sub-agents in native child sessions (`child_session_available`) | not mapped | root `tokenUsage` per turn; `childTokenUsage` added to the session `total` only | no edges | native UUID; saved cwd required | [native/current mapping](../runtimes/factory.md) |
| qoder | native parent tool ids on forwarded child frames | `parent_tool_use_id` | root per-query reports summed since open; no inferred child usage | no inferred child-session edges | native UUID in the same HOME/project | [native/current mapping](../runtimes/qoder.md) |
| qwen | native parent tool ids on forwarded child frames | `parent_tool_use_id` | fresh total only; resumed totals unknown without a baseline | no inferred child-session edges | native UUID in the same HOME/project | [native/current mapping](../runtimes/qwen.md) |
| claude | native subagent messages can share the stream | `parent_tool_use_id` | the root's main loop (`result.usage`); subagents and compaction in the session total (`modelUsage`), `unattributed` ([env] 2.1.292) | `agentPath` (not in graph) | native session id | [native/current mapping](../runtimes/claude.md) |
| codex (app-server) | native child threads and collaboration items on the parent's connection | `senderThreadId` / `receiverThreadIds`; `subAgentActivity.agentThreadId` ([env]: `started` on the root names the child, `interacted` on the child names the root) | both threads report their own running total in `thread/tokenUsage/updated`; the child's is in its own session's records, not in the root's `usage().total` ([env]) but in its `withChildren`; the root's counts from when the Session opened ([#169](attribution.md#usage-one-constraint)) | native thread topology; child threads are child sessions | `threadId`; `expectedTurnId` is a steer precondition | [pinned schema/current mapping](../runtimes/codex.md) |
| pi-durable | native child conversations exist, outside the selected watch | no inferred edges | own model/tool ledgers since attachment | no child graph projected | numeric conversation id in host storage | [native/current mapping](../runtimes/pi-durable.md) |
| pi | no native (host composes) | host-nested sessions | flat (host splits) | no runtime-reported edges | session id | [src] |
| cursor (`@cursor/sdk`) | wrapper records (#2) in the parent run's updates | the `task` call id on `tool-call-delta` | each run's `turn-ended` usage is the root's; none seen for a child ([env]) | `agentPath` (not in graph) | `agentId` | [native/current mapping](../runtimes/cursor.md) |
| grok (ACP) | nested sessions (#3), same connection | child has its own ACP sessionId | child ledgers stay native-only: the root's prompt ledger already includes a foreground child's spend, and `withChildren` is absent ([grok](../runtimes/grok.md#context-usage-billing-and-compaction)) | parent→child session edges (in graph, [sym]) | ACP `sessionId` | [native/current mapping](../runtimes/grok.md) |
| antigravity (ACP) | opaque (#1); CLI child attribution unverified | `start_subagent` tool card only; child id only as a `toolCallId` prefix | no usage reported for any session ([env]) | nothing fabricated | ACP `sessionId` | [native/current mapping](../runtimes/antigravity.md) |
| codebuddy (ACP) | child identity mapping unverified | nothing inferred | context reports only; token ledger unknown | no inferred child edges | ACP session ID | [mapping](../runtimes/codebuddy.md) |
| devin (ACP) | child identity mapping unverified | nothing inferred | no usage ledger mapped | no inferred child edges | ACP `sessionId`; saved cwd required | [mapping](../runtimes/devin.md) |
| hermes (ACP) | child identity mapping unverified | nothing inferred | no per-turn ledger mapped (the prompt reply is session-cumulative) | no inferred child edges | ACP `sessionId`; the gateway moves the session to the requested cwd | [mapping](../runtimes/hermes.md) |
| kimi (KAP) | native agent graph (#2) over WebSocket (`agent_id`, dynamic child subscription) | `item.agent_refs`, `task.child_agent_id` + `parent_tool_call_id` | per-`agent_id` totals from `turn.updated` `step.usage` and `turn.ended` `turn.usage` | `agentPath` (not in graph) | HTTP `GET /sessions/{id}` + `POST /sessions/{id}:resume` | [native/current mapping](../runtimes/kimi.md) |
| kimi (ACP fallback) | opaque (#1): default subscribes main agent only | root `Agent` tool card only | no typed child usage exposed | nothing fabricated from display text | ACP `sessionId` | [native/current mapping](../runtimes/kimi.md) |
| opencode v1 (ACP) | opaque (#1): child sessions not forwarded | root `task` tool card only | no child usage exposed | nothing fabricated | ACP `sessionId` (opencode `ses_` id) | [native/current mapping](../runtimes/opencode.md) |
| opencode v2 (ACP) | child updates forwarded on the parent envelope (2.2.x); background children on `opencode/session/child_update` (2.3.0) | native child `id` / `parentID` metadata; on 2.3.0 also the `subagent` call's `rawOutput.metadata.sessionID` | from 2.0.22 the root prompt sums its own steps; child updates report context only, so `withChildren` stays absent | native parent/child session edges | native ACP session id | [v2 mapping](../runtimes/opencode.md#opencode-v2) |
| kimi-cli (native wire) | wrapper records (#2): `SubagentEvent`, one stream | `parent_tool_call_id` + `agent_id` + `subagent_type` | child events self-attribute | `agentPath`, recursive (not in graph) | session / agent_id | [src] |
| kimi-code (native KAP) | agent graph (#2): key = `(session_id, agent_id)` | `item.agent_refs`, `task.child_agent_id` + `parent_tool_call_id` | per-agent `turn.updated` `step.usage` and `turn.ended` `turn.usage` | `agentPath` (not in graph) | session / `agent_id` | [src] |

## User configuration

Give `SessionOptions.userConfiguration` as `"include"`, `"exclude"`, or
`{ exclude: [...] }` with categories `settings`, `mcp` and `instructions`.
An omitted option, `"include"` and an empty list preserve the runtime's usual
configuration. A list containing all three categories equals `"exclude"`.
Order and duplicate entries have no effect. Claude accepts every subset.
Excluding its user settings source also removes user-scope MCP. Project and
local-scope MCP survive until `mcp` is excluded. See the
[Claude category table](../runtimes/claude.md#user-configuration).

`"exclude"` skips user-level plugins, skills, commands, agents, MCP, hooks,
memory and settings while retaining the native login, native session data
and supported host-provided options. It never copies refresh tokens into a
separate store, hides history in a disposable home, or rewrites native
history indexes. Existing conversation content is not erased on resume.
Supply the option on every open, including resume.

This selects configuration sources, not a filesystem or network sandbox.
Tools keep their normal access, managed organization policy remains native,
and project configuration is runtime-specific. A project can explicitly
refer to files elsewhere. Host options retain their existing refusals, so
`exclude` does not make Cursor accept an otherwise refused MCP server.

| Runtime | `exclude` |
|---|---|
| Claude | Native project/local settings, strict host MCP, disabled auto-memory and account MCP, and excluded home-directory memory; original credential and transcript locations remain. |
| Cursor SDK | Explicit empty `local.settingSources` and `local.sandboxOptions.enabled: false`; SDK login and native store remain. Project layers are also absent under exclusion. |
| Codex | Refused: the temporary-home workaround leaves shared history indexes pointing at paths deleted during cleanup. |
| Kimi | Refused: native atomic writes replace the workspace-index symlink and split the workspace catalog. |
| Pi, Pi Durable, Grok, OpenCode v1/v2, Qwen, Qoder, Antigravity, CodeBuddy, Devin, Factory, Hermes | Refused: no verified separation preserving login and history. |
| DSH | Refused: no verified exclusion that keeps its provider routes. |

A refusal is `UnsupportedOptionError("userConfiguration", reason)` before
starting a session and is declared in `Runtime.refusedSessionOptions`.
`userConfiguration` in this map refuses every nonempty exclusion.
`partialUserConfiguration` refuses proper nonempty subsets, as on Cursor,
whose SDK selects settings sources as a group. See each [runtime page](../runtimes/README.md) for native evidence.

## Native memory default

`SessionOptions.nativeMemoryDefault: "off"` lowers a runtime's own default for
native background auto-memory without overriding explicit user, workspace or
system configuration. Omission preserves the runtime's native default. This is
distinct from `userConfiguration: { exclude: ["instructions"] }`, which hard
disables auto-memory regardless of user settings.

`Session.capabilities.nativeMemory` (`"on"` or `"off"`) reports the effective
native auto-memory state when the adapter can read it at open without adding
open-time wait. Absence means unknown (unreadable, unverified version,
trust-gated workspace settings, or a runtime whose effective state requires an
extra open-time query), never `"off"`.

| Runtime | `nativeMemoryDefault: "off"` | `Session.capabilities.nativeMemory` |
|---|---|---|
| Qwen (`>= 0.26.0`) | Merges over any existing `QWEN_CODE_SYSTEM_DEFAULTS_PATH` or OS `system-defaults.json` into a private `0700`/`0600` temp file with `memory.enableManagedAutoMemory`, `memory.enableManagedAutoDream` and `memory.enableAutoSkill` set to `false`, leaving the original untouched; user, workspace and system settings still override it ([details](../runtimes/qwen.md#native-memory-default), [vendor test](../../sea-trial/vendor/qwen-native-memory.vendor.test.ts)). | Read across Qwen's four layers (`systemDefaults < user < workspace < system`); omitted below `0.26.0`, on unreadable/malformed layers, when `security.folderTrust.enabled` is `true` with workspace memory overrides, or when unmodeled runtime gates (`--bare`, `--safe-mode`, `--sandbox`, sandbox settings, or corresponding env overrides) are present. |
| Qwen (`< 0.26.0` or unreadable) | Refused at open (`UnsupportedOptionError("nativeMemoryDefault", ...)`), declared in `sessionCapabilities`. | Omitted. |
| Claude | Refused at open: Claude's settings layers (`userSettings`, `projectSettings`, `localSettings`, `flagSettings`, `policySettings`) have no below-user default layer; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `--settings` hard-override user settings. Use `userConfiguration: { exclude: ["instructions"] }` for a hard disable ([details](../runtimes/claude.md#user-configuration)). | Omitted so open stays immediate without waiting for a control reply. |
| All other built-in runtimes | Refused at open (`refusedSessionOptions.nativeMemoryDefault`): no native background auto-memory feature or no verified below-user default layer. | Omitted. |

## Session log upload

`SessionOptions.sessionLogUpload: "off"` stops the runtime from sending the
session's transcript or log to its vendor outside the model requests
themselves. Omission preserves the user's and runtime's own settings; there is
no `"on"`. When given, `"off"` wins over a user opt-in (the protective
direction). Separate telemetry metrics are out of scope. Supply it again on
resume.

| Runtime | `sessionLogUpload: "off"` |
|---|---|
| DSH (`>= 0.2.1-rc.5`) | Adds `{ id: "session-log-deepseek", name: "@deepseek-ai/dsh-session-log-deepseek", config: { enabled: false } }` to OAR's private invocation `--patch` (overriding home `enabled: true` without editing user files) and verifies the loaded plugin entry fail-closed before any agent or model request; covers root, native `subagent` children, and resumed sessions ([details](../runtimes/dsh.md#session-log-upload), [vendor test](../../sea-trial/vendor/dsh-session-log-upload.vendor.test.ts)). |
| DSH (`< 0.2.1-rc.5` or unreadable) | Refused at open (`UnsupportedOptionError("sessionLogUpload", ...)`), declared in `sessionCapabilities`. |
| All other runtimes | Refused at open (`refusedSessionOptions.sessionLogUpload`): no verified switch. |

## Native permissions

`SessionOptions.nativePermissions: "inherit"` leaves the runtime's own
permission, approval and sandbox configuration in charge for that session
instead of injecting OAR's default bypass flags. Omission preserves OAR's
default noninteractive bypass; there is no `"bypass"` value, and any defined
value other than `"inherit"` is refused with `UnsupportedOptionError` on
`nativePermissions`. Supply it again on resume and fork; the launch choice is
not recorded. Inheriting native approvals does not add an interactive approval
channel: any server approval request that still reaches OAR is recorded and
immediately declined so turns never hang.

| Runtime | `nativePermissions: "inherit"` |
|---|---|
| Codex | Omits `-c sandbox_mode=...`, `approvalPolicy`, and `sandbox` on `thread/start`, `thread/resume`, and `thread/fork` (winning over `process.env.OAR_CODEX_SANDBOX` for that session). `thread/start` reads `sandbox_mode`, `approval_policy`, and `approvals_reviewer` from `CODEX_HOME/config.toml` (or `~/.codex/config.toml`); `thread/resume` and `thread/fork` follow Codex's native precedence (persisted rollout permissions before `config.toml`), so omission on a subsequent open is what restores OAR's bypass over a persisted restricted rollout (`read-only` or Windows `workspace-write`) by sending `sandbox` alongside `approvalPolicy: "never"`. Host `launchArgs` (such as `-c sandbox_mode=...`) suppress OAR's RPC `sandbox` override and take CLI precedence on `thread/start` (`thread/resume` restores persisted rollout profiles ahead of CLI `-c`). Requests routed to Codex's own reviewer (`guardian_subagent` / `auto_review`) settle natively; requests reaching OAR (such as `approvals_reviewer = "user"`) are recorded as `toApp` and immediately declined ([details](../runtimes/codex.md#tools-permissions-and-client-callbacks), [vendor test](../../sea-trial/vendor/codex-native-permissions.vendor.test.ts)). |
| All other runtimes | Refused at open (`refusedSessionOptions.nativePermissions`): no verified per-session inherit switch. |

## User questions

`SessionOptions.userQuestions: "host"` leaves the agent's questions to the
host: each stays an open `toApp` request, with no deadline, until
`Session.answerQuestion` answers or declines it, the runtime withdraws it
(`app_request_cancelled`), or the runtime is gone. Questions only: approvals
and MCP elicitations keep their automatic refusals. Omission keeps the
runtime's unattended behavior. Supply it again on resume and fork; it is not
recorded. Evidence: [probe](../../experiments/user-questions-2026-11-25.md),
[vendor test](../../sea-trial/vendor/user-questions.vendor.test.ts).

| Runtime | `userQuestions: "host"` |
|---|---|
| Claude (`>= 2.1.274`) | Single choice, several choices and free text. Adds `--permission-prompt-tool stdio` and disallows `EnterPlanMode` and `ExitPlanMode`; every `can_use_tool` that is not `AskUserQuestion` is denied. Refused with `--permission-mode` or `--permission-prompts` in `launchArgs`. |
| Codex (`>= 0.107.0`) | Single choice and free text; several selected options are rejected `unsupported`. Sets `features.default_mode_request_user_input=true`, which Codex marks under development. |
| All other runtimes, and older or unreported versions | Refused at open (`refusedSessionOptions.userQuestions`). |

## Session controls

`prompt`, `queue` and `abort` are on every session. `steer`, `withdraw` and `stopTask`
are members a session may lack: a control the runtime cannot do is an
absent member, never a request that is always rejected
([record stream](record-stream.md#the-rules)). Where `queue.durable` is
false, the adapter holds queued input in this process; a synchronous observer
of a `prompt` request that reentrantly calls `queue` places the queued entry
before that `prompt` decides, so adapter-held sessions refuse the `prompt` as
`busy` and drain the queued entry instead.

| runtime | `steer` | `withdraw` | `capabilities.queue.durable` |
|---|---|---|---|
| dsh | yes where the bridge reports the agent's `steer` at open: `agent.steer`, the native next-step inbox | yes: native `inbox.remove`, for input held for a later turn | no: native dispose clears the inbox; a crash can leave input that runs at the next wake ([mapping](../runtimes/dsh.md#session-options)) |
| factory | yes: a second `droid.add_user_message`, queued `end_of_turn` and drained into the running turn, which ends once | yes, while held | no ([mapping](../runtimes/factory.md#prompting-steering-queueing-and-abort)) |
| qoder | yes: stdin user message with `priority: next`, joining at a tool boundary or following a text-only turn | yes, while held | no |
| qwen | no: native busy writes queue | yes, while held | no |
| claude | yes: a user message written to stdin mid-turn | yes | no |
| codex | yes: `turn/steer` with `expectedTurnId` | no: the queue is codex's own (`thread/queue/add`; [why](record-stream.md#withdrawing-held-input)) | yes |
| pi-durable | yes: native `submit`, `whenBusy: steer` | yes: `submission.abort()` | yes |
| pi | yes: the SDK session's `steer` | yes | no |
| cursor (`@cursor/sdk`) | yes, text only: `run.steer` (images are rejected `unsupported`); `complete_delivered` and SDK 1.4.0 `queued` are accepted (a queued steer is Cursor's follow-up, unobserved by OAR), `revert_to_followup` is refused ([mapping](../runtimes/cursor.md#prompt-steering-queueing-and-abort)) | yes | no |
| grok (ACP) | yes: `_x.ai/interject`, taken into the running turn at its next safe point without cancelling it; one that misses the turn runs as Grok's own ([mapping](../runtimes/grok.md#prompting-steering-queuing-and-cancellation)) | yes | no |
| codebuddy (ACP) | absent: no verified injection interface | yes | no |
| devin (ACP) | absent: no verified injection interface | yes | no |
| hermes (ACP) | absent: no verified injection interface; queued input is held by OAR | yes | no |
| kimi (KAP) | yes (`POST /sessions/{id}/steer`) | yes, while held | no |
| kimi (ACP fallback) | no | yes | no |
| antigravity (CLI ACP) | yes | yes | no |
| opencode v1 (ACP) | yes: a plain prompt RPC mid-turn, which joins the running loop at its next step; both prompts are answered at idle | yes | no |
| opencode v2 (ACP) | yes where `initialize` advertises `_meta.steering.supported` (2.2.7 and later): `_session/steering`, `injected` is accepted into the running turn, `promptRequired` is `no_active_turn` ([mapping](../runtimes/opencode.md#v2-session-behavior); verified natively on 2.3.0, including that abort keeps an accepted steer and slash commands steer as text). Otherwise absent: concurrent native prompts are refused; `steerOrQueue` and `deliver` use the host queue | yes | no |

For ACP runtimes with `steer` (Grok, Antigravity, OpenCode v1 and v2), OAR
rechecks the original active turn after startup waits and at SDK dispatch.
A turn that ended, was replaced or has an abort in progress yields
`rejected` / `no_active_turn`, with no native prompt sent. Acceptance follows
dispatch; a steer waiting to send does not hold the original turn open.

### Session capabilities before open

A host that lays out a composer before any session exists (a steer button,
an image picker) reads `Runtime.sessionCapabilities(installation)`. It is
pure and synchronous: no process, no I/O. Each field mirrors the session
that installation would open: `steer` is whether `Session.steer` exists,
`images` is `capabilities.images`. A field is absent where only the native
handshake at open can tell; a host treats absent as unknown, never as false,
and the opened session stays authoritative.

| runtime | `steer` | `images` | `stopTask` | `mcpTransports` | `contextUsage` | `fileChanges` | `nativeSessionFile` | `sideQuestion` |
|---|---|---|---|---|---|---|---|---|
| antigravity | true | absent: advertised by `initialize` | false | `["stdio", "http"]` (`minVersion` 1.5.0 with `--process-per-session`, credential-free only per `refusedSessionOptions.mcpServerCredentials`; [mcp-servers-acp.vendor.test.ts](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts)) | `{ tokens: true, contextWindow: true }` | absent | absent | absent |
| claude | true | true | true | `["stdio", "http"]` ([mcp-servers.vendor.test.ts](../../sea-trial/vendor/mcp-servers.vendor.test.ts)) | `{ tokens: true, contextWindow: true }` | absent | absent | true from 2.1.326, absent on older or unreadable versions |
| codebuddy | false | absent: advertised by `initialize` | false | `["stdio", "http"]` on `>= 2.178.1` ([codebuddy.vendor.test.ts](../../sea-trial/vendor/codebuddy.vendor.test.ts)); absent on older or unreadable versions | `{ tokens: false, contextWindow: false }` (native `0/0` when model limit is unknown is not trustworthy) | absent | absent | absent |
| codex | true | true | true | `["stdio", "http"]` ([mcp-servers.vendor.test.ts](../../sea-trial/vendor/mcp-servers.vendor.test.ts)) | `{ tokens: true, contextWindow: true }` on `>= 0.151.0`; absent on older or unreadable versions | true from 0.160.1, absent on older or unreadable versions | true from 0.169.0, absent on older or unreadable versions | absent |
| cursor | true (an individual steer can still be rejected: `unsupported` with images, `runtime_refused` when the run cannot take it, as above) | true | false | `["stdio", "http"]` ([cursor-mcp.ts](../../experiments/cursor-mcp.ts)) | `{ tokens: true, contextWindow: false }` | absent | absent | absent |
| devin | false | absent: advertised by `initialize` | false | absent: handshake-dependent and unverified in CI | absent: live turns unverified | absent | absent | absent |
| hermes | false | absent: advertised by `initialize` (true at open on the probed build) | false | `["stdio"]` (HTTP refused: no advertised `mcpCapabilities.http`). A stdio entry with `env` attaches on 0.23.3 only; older, newer and unreadable versions declare `mcpServerCredentials` and refuse it ([hermes](../runtimes/hermes.md#session-mcp-servers)) | `{ tokens: true, contextWindow: true }` | absent | absent | absent |
| dsh | absent: the bridge reports the agent's methods at open | absent: the selected model and native attachment store determine image support | true | `["stdio", "http"]` ([stdio](../../sea-trial/vendor/dsh-mcp.vendor.test.ts), [credentialed stdio and HTTP](../../sea-trial/vendor/dsh-mcp-credentials.vendor.test.ts)) | `{ tokens: true, contextWindow: true }` | absent | true from 0.2.2-alpha.2, false below 0.2.2-alpha.2, absent on unreadable versions | absent |
| factory | true | true | false | absent: HTTP MCP tool invocation unverified (only stdio is exercised in [factory.vendor.test.ts](../../sea-trial/vendor/factory.vendor.test.ts)) | `{ tokens: true, contextWindow: true }` | absent | absent | absent |
| grok | true | true | false | `["stdio", "http"]` on `>= 1.0.46` ([mcp-servers-acp.vendor.test.ts](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts)); absent on older or unreadable versions | `{ tokens: true, contextWindow: false }` | absent | absent | absent |
| kimi | true on botiverse `>= 2.7.2-botiverse.1` (KAP); false on unreadable versions or `< 2.7.3` non-botiverse (ACP fallback); absent on upstream `>= 2.7.3` (probe-dependent) | absent before open (true on botiverse KAP `>= 2.7.2-botiverse.1`) | true on botiverse KAP `>= 2.7.2-botiverse.1`; false on unreadable versions or `< 2.7.3` non-botiverse (ACP fallback); absent on upstream `>= 2.7.3` (probe-dependent) | `["stdio", "http"]` on `>= 2.1.1` ([mcp-servers-acp.vendor.test.ts](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts)); absent on older or unreadable versions | `{ tokens: true, contextWindow: true }` (except models whose catalog entry has no size) | absent | absent | absent |
| opencode | true on a v1 installation; absent on v2 or an unreadable version (`initialize` advertises steering) | absent: advertised by `initialize` | false | `["stdio", "http"]` on v1 `>= 1.18.30` and v2 `>= 2.0.26` ([mcp-servers-acp.vendor.test.ts](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts)); absent on older or unreadable versions | `{ tokens: true, contextWindow: true }` on readable v1/v2 versions; absent on unreadable versions | absent | absent | absent |
| pi | true | true | false | `["stdio", "http"]` ([mcp-servers-pi.vendor.test.ts](../../sea-trial/vendor/mcp-servers-pi.vendor.test.ts)) | `{ tokens: true, contextWindow: true }` | absent | true | absent |
| pi-durable | true | false | false | `[]` | `{ tokens: false, contextWindow: false }` | absent | absent | absent |
| qoder | true | false | true | `["stdio", "http"]` ([qoder.vendor.test.ts](../../sea-trial/vendor/qoder.vendor.test.ts)) | `{ tokens: false, contextWindow: false }` | absent | absent | absent |
| qwen | false | false | false | `["stdio", "http"]` on `>= 0.26.0` ([qwen.vendor.test.ts](../../sea-trial/vendor/qwen.vendor.test.ts)); `["stdio"]` on readable `< 0.26.0` (HTTP refused at open); absent on unreadable versions | `{ tokens: true, contextWindow: true }` on `>= 0.26.0`; absent on older or unreadable versions | absent | absent | absent |

Every runtime built with `defineRuntime` has the member; one that declares
neither field answers with its static declarations only. Community runtimes
declare their own (morph: `taskEventTypes: []`, `steer: true`, `images: false`; cybion: `taskEventTypes: []`, `steer: true`, `images: true`).

The same answer carries what depends on the installed version. Its
`refusedSessionOptions` is this installation's complete set: the static
`Runtime.refusedSessionOptions` plus refusals a release adds (an option below
its measured floor). As for the static map, a declared option is always
refused at open. A refusal that depends on the version belongs only in this
answer: whatever the static map refuses, every version refuses.
`manualCompaction` is this installation's value,
`compactionEvents` says whether native automatic compaction reports
`compaction_started` and `compaction_ended`, and `contextUsage` says whether
`Session.contextUsage()` reports `tokens` and `contextWindow` by the end of a
completed turn ([`ContextUsageCapability`](../../packages/oar/src/contracts/context-usage.ts)
names which turns, and the compaction exception); each is absent where not established. `session.capabilities-match-declaration` asserts every declared `steer`, `images`, `stopTask`, `nativeSessionFile` and `contextUsage` claim against the opened session. For `mcpTransports`, it checks open-time acceptance when `"http"` is declared (opening with a local loopback HTTP MCP server) or open-time `UnsupportedOptionError("mcpServers")` when `mcpTransports` omits `"http"`; opening alone does not prove end-to-end HTTP transport execution because several runtimes drop a server that fails to attach without failing the open, so end-to-end HTTP tool invocation is proved by each runtime's MCP vendor test or probe linked in the table above. `defineRuntime` and `installedSessionCapabilities(runtime,
installation)` merge the static declarations in, so a host reads one answer
and never branches on a runtime's name. `orient()` returns it for every
available installation ([orientation](orientation.md#session-capabilities)).

The optional `nativeSessionFile` declaration tells a host whether it can ask the
opened session for its own persisted file. Codex declares it from 0.169.0 for
`thread.path`. DSH declares it from 0.2.2-alpha.2 for `sessionPersistence.stat(id).location.path`
(`0.2.1-rc.5` omits `location`, so it declares `false` below `0.2.2-alpha.2`).
Pi declares it for the SDK and supported RPC sessions, both of which report
`sessionFile`. Other installations leave the declaration absent.

### Platforms and credentials

`Runtime.verifiedPlatforms` lists the operating systems (`process.platform`)
where OAR's CI (`ci.yml` push/release gate or the daily `platform-matrix.yml`
workflow) runs OAR's behavior suite against the runtime's real binary or SDK.
Observation runs do not count: Windows runs for Kimi and Grok
(`acp-windows.yml`) remain observations and are excluded. The values
live in one table
([platforms.ts](../../packages/oar/src/platforms.ts)), and a test keeps it
equal to the CI evidence in both directions. A runtime without an entry is
unknown, not unsupported. The claim covers the CI-pinned version; an older
supported version may be unverified on some systems.

`Runtime.credentials` describes what the runtime reads on its own, never a
value: scope (`single_account` or `per_provider`), management (`native` when
the runtime owns credential management, or `external` when it has no native
login and the person or host supplies credentials), sign-in paste kind
(`signInPaste`: `none`, `code` or `code_or_url`), usage store directory env
(`usageDirectoryEnv`), value-interpolation syntaxes (`interpolation`),
controlled environment variables (`env`, each with `purpose`, `secret`,
`field` and optional `provider`), and every file, directory or keychain store
(`stores`, in the runtime's own precedence, with `directoryEnv`,
`fallbackDirectoryEnvs`, `defaultDirectory`, `path`, `service` and
`overridesEnv`). A `.env` the runtime reads from the session's directory is
listed too, since it can supply a key the host never passed. A host isolates
one agent's stores by setting `stores[].directoryEnv` (or a fallback in
`fallbackDirectoryEnvs`). It clears or supplies the names in `env` to control
inherited credentials and provider routes. These lists are strictly disjoint so
credential cleanup preserves store isolation. Hosts keep secrets off command
lines. Native login is the `login` member and per-provider keys are
`providers`. Each built-in runtime's declaration is the single source of truth,
exposed through `Runtime.credentials` and `orient()` whether or not the runtime
is installed.

A declared variable's `purpose` and `field` tell the host why it participates
in credential isolation and which logical credential field owns it. Clients
that read different sets of variables have separate precedence rules. See the
[Claude credential sources and provider routes](../runtimes/claude.md#credentials).

| Purpose | What the native runtime reads it for |
| --- | --- |
| `api_key` | A provider key or signing credential. |
| `token` | A bearer, session, identity or refresh token. |
| `base_url` | The endpoint that receives an authenticated request. |
| `provider_selector` | Selects a provider client or changes how it authenticates the request. |
| `region` | Selects a signing or deployment region. |
| `account_scope` | Selects the organization, project, resource or scope under a credential. |
| `model_route` | Selects the model or cloud deployment that receives the request. |
| `credential_source` | Identifies a credential provider, profile, file, directory or descriptor. |
| `headers` | Supplies request headers that can carry credentials. These are secret. |

### One side question from a saved session

`runtime.sideQuestion(installation, { sessionId, cwd, question })` answers once
from the history already saved by that native session. The source may be
running or stopped. The host can also supply `env`, `model`, `timeoutMs` and
`signal`. Claude declares `sessionCapabilities(installation).sideQuestion`
from 2.1.326. Other runtimes omit the operation.

Pass the source's environment overrides, including any `CLAUDE_CONFIG_DIR`,
so Claude can find the session in the same native store. When `model` is
omitted, Claude selects its configured default. Pass the source model
explicitly when it should answer the side question.

The fork has no tools or MCP servers, disables user and project hooks, and
saves no transcript. Administrator policy still applies. The answer is
returned to the caller. Source history stays unchanged. See the [Claude
runtime page](../runtimes/claude.md#side-questions).

### MCP startup before the first input

Codex declares `mcpStartup.kind: "per_server"` from 0.169.0. On the two
measured versions, 0.169.0 and 0.170.0, the first model request could run
while tool discovery was pending. Per-server
`mcp_server_startup` events and `mcpStartupOf(records, sessionId)` let a host
wait for its required servers before submitting input. An absent declaration
means unknown. See the [Codex measurement](../runtimes/codex.md#session-mcp-servers).

### Recovery after automatic compaction fails

A host can read the failed turn from `turn_ended.outcome`, then check
`status()` before its next input. After a measured failed automatic
compaction, Claude, Pi, DSH, OpenCode v2 and threshold-triggered Codex
returned to idle and completed the next prompt on the same session.
The failure class and available compaction events vary by runtime.
[Measured versions, controls and unknowns](../../experiments/manual-compaction/automatic-failure.md).

### Native tasks and single-task stop

`sessionCapabilities(installation).taskEventTypes` lists verified native task
classes, is empty for adapters with no task projection and is absent when
unverified. `subagentResults.foreground` identifies a parent tool result in
the originating turn. `subagentResults.background` identifies child text or
a terminal task's `output` that can be observed without another host input.
Missing modes remain unknown. See [child result timing and version coverage](../../experiments/task-controls/child-output.md).

| Runtime | Native task lifecycle | `stopTask(taskId)` |
| --- | --- | --- |
| Claude | `system/task_started`, patches, changed progress descriptions, notifications | Native `stop_task`; acceptance is not an end. |
| Codex | Parent `subAgentActivity` items | Interrupt the known child's active turn; no parent abort or synthesized task ending. |
| Qoder | Native task starts, patches, progress and notifications | Native `stop_task`, verified on 1.1.83 foreground/background agents. |
| Grok | Parent `subagent_spawned` / `subagent_finished` | Absent: child `session/cancel` left its work running on 1.0.77. |
| Qwen | `system/task_started` / `task_notification` with nested `data`, verified on 0.26.8 | Absent: no verified host single-task control. |
| OpenCode 2.3.0 | `opencode/session/child_update` status `created`, `running`, `completed`, `failed`, `interrupted` | Absent. |
| DSH | `subagent/start` / `subagent/end`; durable `job/registered` / `job/settled` for shell and other jobs, including foreground commands ([mapping and completion boundaries](../runtimes/dsh.md#root-completion-and-background-work)) | Native `jobs.kill` and `jobs.wait` for this session's explicitly backgrounded shell jobs. |
| Kimi (KAP) | WebSocket `task` frames (`subagent` → `agent`, `shell` → `shell`, else `other`, with `toolCallId` and `background: detached`) on `>= 2.7.2-botiverse.1` | WebSocket `task.stop` for the task's `agent_id`. |
| Other runtimes | Existing runtime-specific observations only | Absent. |

The [contract](subagents.md#native-single-task-stop) distinguishes native
acknowledgement from completion. [Evidence](../../experiments/task-controls/README.md)
is version-specific and does not establish every native task type or platform.

### What `abort` stops

`abort` ends the active turn: accepted means the runtime was asked to
interrupt, and the outcome is the runtime's own turn end. It does not promise
that processes the turn started have stopped. Some runtimes keep a command
running across turns on purpose, so a later turn can read its output. Ending a
session with `dispose()` is a different operation. Where OAR owns the
runtime's process, it stops that process tree and, for ACP runtimes, every
terminal OAR hosted for the session. A Pi Durable session on a host-owned
harness is the exception: `dispose()` ends OAR's observation and leaves the
harness's work running.
Unless dated separately, observed on Linux on 2026-10-28 with a command
that starts a parent and a child process ([report](../../experiments/runtime-resources-2026-10-28.md)):

| runtime | after `abort` | how the command is stopped |
|---|---|---|
| codex 0.165.0 | keeps running until it exits by itself (about 45 s in the probe), both in an OAR session and in a shared app-server; OAR's 10 s fallback does not apply once codex has ended the turn | `dispose()`, or [`endTurnProcessesOnAbort`](#ending-a-turns-processes-on-abort) on a session that opted in. Native `thread/backgroundTerminals/terminate` and `thread/archive` also stop the probed command; OAR does not call them |
| grok 1.0.70 (ACP) | keeps running: native cancel and close leave the terminals grok created through the host | `dispose()` releases every terminal OAR hosted for the session, or [`endTurnProcessesOnAbort`](#ending-a-turns-processes-on-abort) stops the aborted turn's |
| kimi 2.3.3, opencode 1.19.5 and 2.2.0, antigravity 1.4.3 (ACP) | stopped within 2 s of the cancel | |
| antigravity 1.5.9 (ACP, Linux 2026-11-17) | foreground `du` stopped; already-backgrounded `du` survived the native cancelled turn; after ordinary turn end, abort returns `no_active_turn` | `dispose()` cleared all observed native and shell process groups ([report](../../experiments/antigravity-disk-scan/README.md)); natural completion is independent of abort |
| claude, codebuddy, devin, dsh, factory, hermes, qwen, qoder, pi (RPC) | not measured | `dispose()`: OAR owns the process |
| pi (in process), cursor (in process) | not measured | they run in the host process: `dispose()` ends the SDK session; whether its commands stop is not measured |
| cursor (subprocess mode) | not measured | `dispose()` stops the session's child, its process group and the descendants found by parent pid (POSIX), plus on Linux every process that kept the child's environment marker, such as a finished command's background job (tested on Linux); a process that cleared the marker, or on macOS one reparented away from the child, is not reached; Windows: `taskkill /T` on its tree, not run ([execution modes](../runtimes/cursor.md#execution-modes)) |
| pi-durable | not measured | the host owns the harness: `dispose()` ends observation only |

A host that must know the command is gone ends a session whose process OAR
owns, or waits for the command's own end in the record stream. It never
infers that from the turn end.

### What the next model request contains after an abort

The host waited for a root `turn_ended: aborted`, then sent an unrelated
plain prompt in the same session. Each column describes interruption
information in the resulting provider request. **None** means the captured
request carried neither an interruption cue nor partial assistant text.
The original user prompt can still be present. **Partial** means the request
included the text emitted before cancellation. These observations describe
the input available to the model. Its answer to the new question still depends
on the model. [Native controls and request excerpts](../../experiments/abort-aftermath/README.md)

| Runtime and measured version | Stream open, no text yet | After one assistant text chunk | During a foreground tool |
| --- | --- | --- | --- |
| Antigravity CLI 1.5.13 | None | Partial, followed by an instruction to continue the old task. This asks the model to do the opposite of what the user requested by stopping it. | Tool response says execution was canceled. |
| Claude Code 2.1.326 | User-interruption marker | Partial and user-interruption marker | Tool-use interruption marker and a tool result explaining that execution may already have had effects. |
| CodeBuddy 2.179.3 | User-interruption marker | Partial and user-interruption marker | User-interruption marker and empty tool output. The marker is in the outgoing request with `skipRun: true`. |
| Codex CLI 0.169.0 | `<turn_aborted>` | `<turn_aborted>` only | `<turn_aborted>` and tool output saying the user aborted it. |
| DSH 0.2.2-rc.5 | None | Partial only | Tool result says the call was aborted. |
| Factory droid 1.12.1 | User-interruption marker | Partial and user-interruption marker | Tool result says the user cancelled execution. |
| Grok 1.0.70 | None | None | Tool result names `user_cancel`. It says the command was never executed, even though the command had already written its start marker. |
| Kimi 2.6.3 | Reminder that the user interrupted the previous turn | Partial and the same reminder | Reminder and a tool result saying the user interrupted it. |
| OpenCode 1.19.5, 2.2.7, 2.3.2 | None | Partial only | Shell result reports an interruption. The 1.19.5 and 2.3.2 results name the user. |
| Pi 1.5.2, in-process SDK and subprocess RPC | None | None | Tool result says the command was aborted. |
| Pi Durable 1.5.2, host-owned harness | None | None | Harness labels the tool result aborted. |
| Qoder 1.1.81, native replay | User-interruption marker | User-interruption marker, partial text dropped | User-interruption marker and a tool rejection. |
| Qwen Code 0.27.4 | None | Partial only | Missing-result notice lists several possible causes, including abort. It suggests retrying if needed. |
| Cursor SDK 1.4.1, in-process and subprocess | Unknown | Unknown | Unknown. No capture of the subsequent request sent by the Cursor backend in either execution mode. |
| Devin CLI, unmeasured | Unknown | Unknown | Unknown. The fixture observes ACP, with no capture at Cognition's model endpoint. |
| Morph Console, unmeasured | Unknown | Unknown | Unknown. The Console task trace does not supply the subsequent provider request in these controls. |
| Cybion, unmeasured | Unknown | Unknown | Unknown. The available Thread history lacks a capture of the deployment's next model request. |

### Ending a turn's processes on abort

`SessionOptions.endTurnProcessesOnAbort: true` makes an accepted abort also end
what that turn started, keeping the runtime and session for the next prompt.
Codex in an isolated app-server and Grok take it; every other runtime, and
Codex in shared placement, refuses it before launch (Grok's shared placement
is not admitted; its experimental shared adapter accepts the option but has
not been run with it). Codex
compares process-table reads; Grok stops the terminals OAR hosted for that
turn ([grok](../runtimes/grok.md#ending-a-turns-processes-on-abort)). Omitted or false
changes nothing. On Windows Codex accepts it and ends nothing, with `failed`
saying why; Grok uses the process-tree kill there, not yet run. A `cleanup` response on the abort request reports the outcome
([record shape](record-stream.md#the-rules),
[Codex mechanism and limits](../runtimes/codex.md#ending-a-turns-processes-on-abort)).

## Native goals

`SessionOptions.goals: true` exposes optional `Session.goal` on Codex and DSH;
other runtimes refuse before launch. Omitted or false exposes no
member. [Contract and boundaries](goals.md), [Codex evidence](../runtimes/codex.md#native-goals), [DSH evidence](../runtimes/dsh.md#native-goals).

## Native plan/checklist

`plan_changed` is an observation with no opt-in and no `Session` member: a
runtime reports its checklist on its own channel, or reports none.
[Contract](plans.md), [Codex evidence](../runtimes/codex.md#native-planchecklists),
[Claude evidence](../runtimes/claude.md#native-planchecklist),
[Grok and ACP](../runtimes/grok.md#plan-and-checklist-updates),
[DSH evidence](../runtimes/dsh.md#native-plan).

| Runtime | Native source | Evidence |
|---|---|---|
| codex | `turn/plan/updated` notification, whole list, `inProgress` spelled its own way | `plan_update` ([env] 0.171.0 capture) |
| claude | the model's `TodoWrite` tool call, whole `todos` argument | `tool_call` with the call id ([src] 2.1.332 tool description and schema) |
| grok, kimi, opencode, qwen, qoder, codebuddy, antigravity, devin, factory, hermes | ACP `session/update` `sessionUpdate: "plan"` | `plan_update` ([schema] SDK 1.4.0; no ACP runtime here captured sending one; Hermes sends one only when its own gateway tracks a checklist) |
| dsh | the model's `todo_write` tool call, whole `todos` argument | `tool_call` with the call id ([env] tool schema) |
| pi | a tool an INSTALLED EXTENSION registers, read from its versioned structured result (`details.oarPlan`, protocol 1) | `tool_call` with the call id, `channel: "extension"`; tool and source come from the opened session's own report ([src] `ToolInfo.sourceInfo`), never from a name, a version or a file |
| cursor, pi-durable, morph | no structured checklist on the adapter's transport | no event |

## Context breakdown

`contextBreakdown` is a member a session may lack, like `steer`: only claude
itemizes its context (`get_context_usage`,
[claude.md](../runtimes/claude.md)). codex, pi and the ACP runtimes report a
total and a window at most, which `contextUsage()` folds; a host shows that
where the member is absent. Cursor SDK 1.4.1 supplies current model-input
count through `model-call-completed`, with no window or percentage; cache
parts are already included. Completed compaction makes that count unknown
until a later call ([source and limits](../runtimes/cursor.md#observation-children-and-history)).

## Native active turns

`turn_started` is the projection of an OAR prompt request. `turn_active` is
an observation from the runtime and carries no request id. It may name an
`inputId` when the runtime identifies the input it started:

| Runtime | Native activity source |
|---|---|
| dsh | the `next-turn` claim of an `agent/inbox/spliced` names the input; a `turn/start` with nothing waiting has no input id |
| factory | a turn end that neither echoed nor gave back a steer OAR sent names that steer's input (droid runs it as a turn of its own); otherwise a non-idle `droid_working_state_changed` while OAR prompted nothing, with no input id ([mapping](../runtimes/factory.md#prompting-steering-queueing-and-abort)) |
| qoder | `command_lifecycle started` identifies the input; startup `system/init` alone is idle |
| qwen | root `system/init` for the sole submitted input; no native command_lifecycle acknowledgement |
| claude | `command_lifecycle started` for a prompt-like write identifies its input; a spontaneous root `system/init` has no input id |
| codex | `turn/started`, including queued turns without another OAR prompt |
| pi | `agent_start`, including runs started directly through the SDK |
| pi-durable | Initial active snapshot or native `pi.live.run` appearing in a conversation delta |
| grok | `_x.ai/queue/changed` `runningPromptId`: OAR names each prompt (`_meta.promptId`), so its own start carries the input id; any other name is Grok's own turn (no input id), ended by its root `turn_completed` |
| kimi (KAP) | WebSocket `turn.started` |

Status becomes running when idle and preserves the current phase when
already running. The session view opens a turn only if none is open, so a
prompt followed by native activity remains one turn. Claude's preceding
`input_queued { inputId }` separates a waiting prompt from an intervening
spontaneous turn; only its matching native start takes that pending input.
This queue fact is reported by Claude, Qoder and Grok (an OAR prompt listed in
Grok's `_x.ai/queue/changed` entries) and excludes steer writes. Child
activity keeps its own attribution and never starts the root turn. Other
adapters do not yet emit `turn_active`. OpenCode 2.3.0 runs a root reply of
its own after a background child's report, but ACP exposes neither its start
nor its end, so neither `turn_active` nor `turn_ended` is mapped for it
([known gap](../runtimes/opencode.md#v2-session-behavior)). Antigravity
1.5.10 and 1.5.11 also deliver unsolicited content without an ACP start/end
pair ([controls](../../experiments/antigravity-active-turns/README.md)).
For these and every adapter without a verified lifecycle mapping, content
stays outside-turn activity, with idle status and no open view turn.
This states the OAR mapping, not that a runtime cannot expose another native
lifecycle source. The ten mapped starts above still open real turns;
preceding activity is never adopted retroactively.

## Tool outcomes

Native sources for the `tool_call_ended` fields (the rule that they are
never derived is in [record-stream.md](record-stream.md#the-rules)):

| runtime | `content` from | `result` from | `exitCode` from |
|---|---|---|---|
| claude | `tool_result.content` (a string or blocks) | stream-json `tool_result.is_error`, optional and false by default in the Messages API, so an absent field is `ok` ([src]; 2.1.288 omits it on successful Read, Write and Edit) | none (`tool_use_result` carries no exit status) |
| codex | `commandExecution.aggregatedOutput`; an MCP call's result blocks (an error as its message); `webSearch` results as one `other` part; else the item's status word | `item/completed.status` `completed`/`failed` ([src]) | `commandExecution` items' `exitCode` ([src]) |
| pi-durable | native result entry's toolResult content | toolResult `isError`, else a nested call's `summary.isError`, only with an actual result | absent for both model and nested calls in Durable 1.5.2 conversation views, even when the tool caller receives a structured code ([test](../../sea-trial/vendor/pi-durable-exit-code.vendor.test.ts), [migration](../../experiments/pi-durable-native-watch/README.md)) |
| pi | `tool_execution_end.result.content` blocks, else the whole result | `tool_execution_end.isError` false/true ([src]) | CodingTools' `result.structuredContent.exit_code` ([env] Pi 1.3.0, [test](../../sea-trial/vendor/pi-exit-code.vendor.test.ts)) |
| grok, kimi (ACP fallback), antigravity, opencode (ACP) | the closing `tool_call_update.content` blocks, else `rawOutput` (grok also projects non-empty `MCP` `rawOutput.output` `OkayOutput`/`Error` strings on `completed`/`failed` to text); text parts are cut at 10,000 characters (`native` keeps them whole) | `tool_call_update.status` `completed`/`failed` ([src]) | `rawOutput.exit_code` on the closing `tool_call_update`: grok ([src] grok 1.0.25), antigravity ([env] agy_acp_server 1.2.1) |
| kimi (KAP) | `item.output ?? item.error` (without the 10,000-character ACP cut) | `item.outcome` (`completed`/`failed`) | `item.fields.exit_code` (number or explicit `null`) |
| morph, cybion (community) | `morph`: `event.text` as text content; `cybion`: `tool_output` payload (`output` string as text, else `other`) | `morph`: `error` / `status` (`failed`/`error`/`done`); `cybion`: absent | `morph`: `shellExitCode` for `bash`/`powershell`; `cybion`: absent |
| cursor (`@cursor/sdk`) | a shell call's stdout and stderr (one empty text part when it printed nothing), a read's file text, an edit's or write's diff, an error's message, else one `other` part ([env] SDK 1.0.35) | `tool-call-completed` `toolCall.result.status` `success`/`error` ([env] SDK 1.0.35) | a shell call's `result.value.exitCode`, `null` when `signal` names one ([env]) |

Codex also reports `fileChanges` on a completed `fileChange` item. Each
`changes[].path` keeps the kind from `kind.type`, plus `kind.move_path`
for a move. See the [recorded patch replay](../../tests/replay/codex-file-changes.test.ts).

A frame without the corresponding native field leaves the key absent; the
native frame stays verbatim beside the event. pi reports a signal as 128
plus its number (SIGTERM is 143), never `null`.

## Model confirmation failures

When an adapter's existing model confirmation rejects a session open,
including resume, it throws `ModelConfirmationError`, exported from the
package root and portable entry. Hosts can distinguish this refusal with
`instanceof ModelConfirmationError` without parsing the adapter's message.
The message retains its runtime-specific explanation.

- `requested` is the caller's model selector.
- `reported` is the native model readback, or `null` if no model string was
  supplied. It can be a display name rather than a selector; OAR does not
  invent an alias or substitute the request for missing readback.
- `catalogSelectorIds`, when present, contains selector strings from the
  last catalog successfully read for this confirmation. An absent property
  means no catalog was read successfully; `[]` means one was read with no
  selector strings. A failed later read retains the earlier observed list.
  Display labels, credentials and other catalog fields are not included.
  These observations do not promise that the selectors are usable.

| Runtime path | Existing confirmation that produces this error | Catalog in the error |
|---|---|---|
| Qoder | Native init name cannot be confirmed by the selector-to-name mapping, or the required catalog query fails | Last successful cache/live read of `get_models`, if any |
| Codex | `thread/start` or `thread/resume` reports a model different from the explicit request | Absent; opening does not enumerate `model/list` |
| Pi SDK, Pi RPC, Pi Durable | Opened session/agent state reports a different or missing model | Absent; resolving one requested model is not a catalog enumeration |
| DSH | The reported `agent.model` route differs from the requested provider/model | Absent |
| Antigravity | The last ACP `config_option_update` model value still contradicts the requested selection at the configuration deadline | Absent |
| Factory | `initialize_session`, or on resume the `settings_updated` after `update_session_settings`, reports a `modelId` other than the request (droid runs its default in place of an unknown model) | Absent; opening reads no catalog |
| Kimi (KAP) | `POST /sessions` (`mapCreateKapError`) or agent options verification rejects the requested model | Absent |

The error class imposes no shared confirmation policy: Codex and DSH still
open when the readback is missing. Explicit native model-unavailable errors and
unsupported options keep their classifications. A Qoder catalog-query
failure uses this error and keeps its underlying `cause`; other
transport/deadline failures keep their errors. A failure to confirm is not
itself evidence for `RuntimeFailureError("model_unavailable")`.
Antigravity waits, within the original 30-second request deadline, for a
successful config RPC and a matching last observed value for the requested
option; a conflicting notification can still be followed by a matching one.
A model still disagreeing at the deadline is a `ModelConfirmationError` with
the last reported value (effort keeps its plain refusal), so a genuine
mismatch is refused only then. No notification naming the option remains a
timeout; RPC failures and process exits fail at once. OAR adds no request,
retry, quiet period or deadline extension, and does not claim to identify
stale notifications or prevent later native changes
([evidence and limitations](../../experiments/antigravity-config-notifications-2026-11-15/README.md)).
Runtime pages describe the native evidence and confirmation limits.

Regression coverage includes creation and resume, missing values, failed
catalog reads, selector provenance, credential redaction and cleanup:
[`tests/model-confirmation-error.test.ts`](../../tests/model-confirmation-error.test.ts),
[`tests/codex/codex-session-resume-model.test.ts`](../../tests/codex/codex-session-resume-model.test.ts),
[`tests/qoder/session.test.ts`](../../tests/qoder/session.test.ts).

## Service tiers

`SessionOptions.serviceTier` selects a runtime-native tier at open, including
resume. Values come from that model's `ModelEntry.serviceTiers`;
`defaultServiceTier` is present only when the native catalog names a default.
`default` is a separate explicit opt-out, accepted by the supporting runtimes
but never inserted into their tier menus. Omitting the option lets the runtime
choose; it does not promise to clear a configured choice. There is no per-turn
setter: reopen the session to change it.

The adapter reads the applied native value before returning. By default, a
refused, missing or different value fails the open with the requested and actual
selection. Hosts that render `Session.serviceTier()` rather than echoing the
request may opt in to `SessionOptions.serviceTierFallback: "default"`: when the
runtime explicitly reports standard service instead of the requested tier (Codex
`serviceTier: null` projected as `default`; Claude `fast_mode_state` `off` or
`cooldown` when `fast` was requested), the open succeeds and reports the actual
tier. Aliases, other named substitutions, absent reports and RPC errors are
still refused. `serviceTierFallback` requires `serviceTier` and rejects any
other value with `UnsupportedOptionError` on `serviceTierFallback` before
opening. OAR does not normalize aliases: codex's `fast` comes back as
`priority` and is refused; use the catalog's `priority`. `Session.serviceTier()`
and `SessionView.serviceTier` report native facts, not the request. Later
native reports of a changed tier remain visible in records and tier events.

Codex uses `thread/start` and `thread/resume`, and enumerates `model/list`.
Claude uses per-process `--settings` and reads `initialize.fast_mode_state`;
only models whose `list_models` entry reports `supportsFastMode: true` list
`fast`. The other runtimes reject with `UnsupportedOptionError` on
`serviceTier`, from their `refusedSessionOptions` declaration. Evidence and
resume details: [Codex](../runtimes/codex.md#service-tiers),
[Claude](../runtimes/claude.md#service-tiers),
[native tests](../../sea-trial/vendor/service-tier.vendor.test.ts).

## Session environment

`SessionOptions.env` is a `Readonly<Record<string, string | null>>` overlay:
a string sets a variable (an empty string remains present), and `null`
removes it from the inherited environment. Omitted keys inherit unchanged;
OAR never changes the host's `process.env`. Windows names are matched without
regard to case. For example, `env: { ANTHROPIC_API_KEY: null,
ANTHROPIC_BASE_URL: "https://provider.example" }` removes an inherited key
while selecting the session's provider endpoint.

Claude, codex, devin, dsh, factory, grok, hermes, kimi, opencode, antigravity, codebuddy, qwen and qoder
apply the overlay to their runtime process and its tool children; ACP client-hosted terminals receive it
too. OpenCode's prompt preparation queries use the same environment. Pi
applies it to its Bash tool's children, not its in-process provider. Cursor in
process and Pi Durable refuse any non-empty `env`, including a removal-only map.
Cursor's subprocess mode applies it to the session's Node child, which runs the
SDK and its tools, over the host's environment or, with `envBase: "clean"`,
over nothing ([child environment](../runtimes/cursor.md#child-environment)). Native tool shells
or runtime configuration can subsequently set their own variables.

An MCP server's own `env` remains a map of strings; `null` there is refused
with `UnsupportedOptionError` on `mcpServers`. Pi also refuses an `env`
removal combined with any stdio `mcpServers`: its native MCP transport
re-inherits the host environment and cannot remove a variable. HTTP-only
servers do not impose this restriction. The refusal is conditional and does
not add `env` to pi's always-refused options.

Session environment options, including removed keys, are not written to the
record stream or voyage header. Runtime-specific removals stay in OAR:
Claude's `CLAUDECODE` marker is always removed. An inherited
`CLAUDE_CODE_ENTRYPOINT` is removed too; an explicit `SessionOptions.env`
entrypoint wins so the host can deliberately choose it. Child-process and native Pi
Bash regressions: [session-env.test.ts](../../tests/session-env.test.ts),
[pi-env.test.ts](../../tests/providers/pi-env.test.ts).

Authentication options accept the same `env` map; use it for login, status,
logout and sessions together. The explicit
[`userShellEnvironment()` helper](login.md#explicit-login-shell-environment)
can capture a login-shell environment for a service host without changing its
process. It is never called implicitly.

## Custom model endpoints

How to point each runtime at another model endpoint (a gateway, a self-hosted
model, a mock), through the runtime's own configuration. OAR adds no endpoint
option; these are the recipes the behavior backends use against a scripted
provider ([`sea-trial/harness/aimock.ts`](../../sea-trial/harness/aimock.ts),
[`aimock-acp.ts`](../../sea-trial/harness/aimock-acp.ts)), so each is exercised
in CI. Keys belong in `SessionOptions.env` or the runtime's own config, never in
`launchArgs` (visible in `ps`).

| Runtime | Where | What |
| --- | --- | --- |
| claude | `SessionOptions.env` | `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` (Anthropic Messages API) |
| codex | `$CODEX_HOME/config.toml`, home set with `SessionOptions.env: { CODEX_HOME }` | `model_provider = "<id>"` and `[model_providers.<id>]` with `base_url`, `env_key` (the variable holding the key) and `wire_api = "responses"` |
| opencode | `$XDG_CONFIG_HOME/opencode/opencode.json` | a `provider.<id>` with its AI SDK `npm` package and `options.baseURL` / `apiKey`, chosen as `model` |
| kimi | `SessionOptions.env` | `KIMI_MODEL_NAME`, `KIMI_MODEL_BASE_URL`, `KIMI_MODEL_API_KEY`, `KIMI_MODEL_PROVIDER_TYPE = "openai"` (chat completions) |
| grok | `$GROK_HOME/config.toml` | `[models] default = "<id>"` and `[model.<id>]` with `base_url`, `api_key`, `api_backend = "chat_completions"` |
| antigravity | OAR maps effective `GEMINI_HOME` to ACP `--gemini-dir`; CLI 1.5.9 ignores that variable itself. Auth-status and usage commands cannot select a nondefault directory: use HOME (Windows USERPROFILE) for all-operation state isolation ([limits](../runtimes/antigravity.md#session-creation-and-resume)) | `antigravity-cli/settings.json` with `modelProvider: "gemini"`, then `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL` |
| dsh | `$DSH_HOME/cordis.patch.yml` | an `llm-pi-ai` row with `config.providers.<id>` (`api: "openai-completions"`, `baseURL`, `apiKeyEnv`, `models`), and `agent-default-model` naming it, or `model` as `<id>/<model>` ([`dsh-aimock.ts`](../../sea-trial/harness/dsh-aimock.ts)) |
| factory | `~/.factory/settings.json` | `customModels` entry (`provider: "generic-chat-completion-api"`, `baseUrl`, `apiKey`, `model`, `displayName`), opened as `custom:<displayName>-<index>` ([`factory-aimock.ts`](../../sea-trial/harness/factory-aimock.ts)) |
| pi | `models.json` in pi's agent dir (`OAR_PI_AGENT_DIR`) | a `providers.<id>` with `baseUrl`, `apiKey`, `api` and its models; process-wide, since pi runs in-process |
| pi-durable | the host's own `Harness` | `models.setProvider(createProvider({ baseUrl, ... }))` |
| cursor | none | Cursor's SDK talks to Cursor's own backend only |
| devin | none | Devin CLI exposes no configurable OpenAI or Anthropic base URL |
| hermes | `$HERMES_HOME/config.yaml` | `model.provider`, `model.base_url`, `model.api_key`, `model.default`; a `custom` provider points at any OpenAI-compatible endpoint, or a named `providers.<id>` entry |

## Disallowed tools

`SessionOptions.disallowedTools` is a readonly list of native names, sent to
native deny channels on both create and resume. Omitted or empty adds no
restriction from OAR; a runtime may restore its own saved settings on resume. OAR neither computes a complementary allowlist nor hides tool
events after execution. This selects tools; another permitted tool can still
perform similar work, so it is not a process sandbox. A model that calls a
denied tool anyway gets the runtime's refusal, not the tool: claude ("No such
tool available"), pi ("Tool … not found"), codex ("unsupported call", with no
tool event), each pinned by its vendor tests. Antigravity CLI 1.5.0 ignores
`_meta.antigravity.disabledTools`, so OAR refuses non-empty lists.

| runtime | can disable | refuses |
|---|---|---|
| claude | native `--disallowed-tools` names, including `Bash` and `mcp__server__tool` | unknown or wrong-case names are accepted silently and disable nothing (for example `bash` is not `Bash`); OAR does not validate them |
| pi | SDK `excludeTools`, built-ins such as `bash` and directly exposed MCP names `mcp__server__tool` | native SDK name/pattern semantics apply; unmatched names are accepted silently and disable nothing |
| cursor | SDK `disallowedTools`, including capability groups `shell` (shell plus stdin) and `mcp` (the whole MCP family) | unknown names, including individual MCP names, become `UnsupportedOptionError`; nested native subagents have their own toolset, so deny `task` to prevent spawning them |
| codex | qualified `mcp__server__tool` on an unambiguously named configured or session MCP server, via session `config.mcp_servers.*.disabled_tools`; prior native denies are preserved | built-ins, unqualified names, missing/ambiguous or normalized server namespaces |
| dsh | agent-scoped native `tools.restrict({ deny })`, on new and resumed opens | unknown, scope-only and reserved transport names; creation-hook shadowing; children have separate scopes ([boundaries](../runtimes/dsh.md#session-name-and-tool-denial)) |
| factory | Refused at open: droid's `disabledToolIds` is not yet verified against these names | `UnsupportedOptionError`, declared in `refusedSessionOptions` |
| qwen, qoder, codebuddy | native `--exclude-tools` (qwen), `--disallowed-tools` (qoder) and `--disallowedTools` (codebuddy, on new and resumed opens) | nothing: OAR passes the names unvalidated and matching is native ([qwen](../runtimes/qwen.md), [codebuddy](../runtimes/codebuddy.md)) |
| grok, hermes, kimi, opencode, antigravity, devin, pi-durable | none through the selected OAR transport | every non-empty list, declared in `Runtime.refusedSessionOptions` |

Value-specific refusals identify the offending names. They are not listed
as an always-refused option on codex or cursor. The native
channels, observed versions and limits are in the
[October 8 audit](../../experiments/disallowed-tools-2026-10-08.md). Supply
the list again when resuming; OAR does not persist host options.

## Process priority

OAR has no option for it. The host owns `installation.command`, so a host wanting
runtime children killed first under memory pressure hands OAR a wrapper that
sets the score before the runtime exists:

```sh
#!/bin/sh
echo 500 > /proc/self/oom_score_adj
exec /path/to/runtime "$@"
```

`exec` keeps the pid, so process ownership is unchanged, and every process the
runtime starts inherits the score, with no window. Linux only, and the kernel
can refuse the write, for example a score below what the process may set. `choom -n 500 -- /path/to/runtime "$@"`
behind `exec` does the same. Measured with Codex 0.167.0 using `choom`: the
app-server, an MCP server and a tool command all read 500
([probe](../../experiments/codex-native-signals/README.md),
[decision](../design/decisions.md#no-stderr-channel-or-process-priority-option-2026-11-06)).

ACP reverse terminals are launched by OAR, so they do not inherit the runtime
process's score automatically. On Linux, OAR reads the requesting agent's
`/proc/<pid>/oom_score_adj` and its own score for each terminal command. Only
when the scores differ does OAR apply the agent's value before executing the
command. Equal scores or an unreadable score keep the original launch path.
A refused write also leaves the host's inherited value;
OAR cannot grant permission to lower a score. No option is added, and other
platforms keep their existing launch behavior.

The [native terminal probe](../../experiments/acp-terminal-priority/README.md)
confirmed reverse terminal requests from Grok 1.0.70, Kimi 2.4.1 and CodeBuddy
2.179.3. OpenCode 1.19.5 and Antigravity CLI 1.5.0 executed this probe through
their own processes, without reverse terminal requests. This inventory covers
the measured command paths and versions, not every tool a runtime may offer.

## Launch arguments

`SessionOptions.launchArgs` adds the host's own command-line arguments to
the runtime process a session starts, for a flag OAR does not model (codex
`-c service_tier="fast"`, claude `--settings` when OAR supplies no settings). Outside documented managed
flags and permission validation, OAR passes them unchecked: it promises
nothing about their effect, and one that changes the protocol
OAR speaks breaks the session. A flag the runtime does not know usually
makes it exit: claude, codex, grok, kimi and opencode all did (2026-10-08),
so the open rejects, except that claude opens with its exit as the first
record. OAR never records them, but they are not secret: any local user can
read a process's arguments (`ps`), so credentials go in `env`. Give them
again on resume.

| runtime | where they go |
|---|---|
| claude | after OAR's own flags, before `--add-dir`, `--mcp-config` and `--disallowed-tools` (each takes several values, so a bare host value after them would be read as theirs) |
| codex | `app-server`, OAR's `-c` overrides, the host's arguments, `--listen stdio://` |
| grok | `agent --always-approve --no-leader`, the host's arguments, `stdio`: `agent` takes its options before `stdio` |
| kimi (KAP) | `web --json --host 127.0.0.1 --port 0`, then host's `launchArgs` (refuses managed KAP flags) |
| kimi (ACP fallback), opencode, devin | after `acp` |
| hermes | refused: `hermes acp` accepts only its own flags and OAR has not verified arbitrary launch arguments |
| antigravity, codebuddy | after OAR's own arguments |
| qwen | after OAR's own flags, before `--include-directories` and `--exclude-tools` |
| dsh | refused: a later native overlay can disable OAR's bridge; effective composition has no verified guard ([evidence](../runtimes/dsh.md#launcher-arguments)) |
| factory | after `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`; the protocol, session and cwd flags are refused |
| qoder | after OAR's own flags, before `--mcp-config`, `--add-dir` and `--disallowed-tools`; from 1.1.81 the same list is the daemon's `worker_args` |
| pi, pi-durable, cursor | refused: they run in the host process through their SDKs, with no command line; cursor's subprocess mode runs the SDK in a Node child of OAR's, with no Cursor command line either |

For Claude, `--permission-mode` (`default`, `dontAsk`, `acceptEdits`, `plan`)
replaces OAR's default bypass and adds `--permission-prompts none`. OAR
refuses `--permission-prompt-tool`, non-`none` prompt targets, missing or
unknown modes, and a conflicting bypass flag before spawning. The mode
and prompt target support both separate-value and equals spelling.

**Claude resume must repeat `--permission-mode`.** OAR does not persist
launch arguments; omission restores `--dangerously-skip-permissions` even
if the preceding process used a restricted mode. Hosts retain and reapply
their own policy. The native `system/init.permissionMode` frame reports
what Claude applied after the turn starts; there is no applied-mode query
before that point. See [native limits and regression evidence](../runtimes/claude.md#tools-permissions-and-extensions).

## Claude partial output

Claude requests partial output for new and resumed sessions: text/thinking
deltas project immediately with the native API message ID; completed blocks
do not repeat them. Tool-argument chunks stream as `tool_call_input_delta`
(the running phase's `writing`), then `tool_call_input` carries the complete
input. See [Claude observation](../runtimes/claude.md#observation-children-and-history).

## Structured output

`SessionOptions.outputSchema` is a JSON Schema object passed unchanged to
native output controls. It applies for the opened OAR Session; give it again
on resume and reopen to change it. There is no per-turn override and OAR
does not validate schemas, validate results, or rewrite instructions to
imitate a missing native channel. Unsupported runtimes refuse even `{}`.

| Runtime | Native scope | Final result |
|---|---|---|
| claude | `--json-schema` for the process, including queued and spontaneous turns | A successful native `result.structured_output` is passed unchanged to `turn_ended.outcome.structuredOutput`. Exhausted validation retries fail the turn. |
| codex | `turn/start.outputSchema` on every OAR prompt; steer retains the active turn's setting | Native text only, including text that violates the schema when the provider does not enforce it. No `structuredOutput` is synthesized. Provider schema refusals remain failed turns. |
| grok | `session/prompt._meta.outputSchema` on prompt and held queue drain; a steer (`_x.ai/interject`) carries none and joins its turn under that turn's schema | Native `_meta.structuredOutput` becomes the completed outcome's value; `_meta.structuredOutputError` fails the turn even when native `stopReason` is `end_turn`. |
| cursor, devin, dsh, factory, hermes, kimi, opencode (both lines), antigravity, codebuddy, qwen, qoder, pi, pi-durable | Refused at open; no verified final-output schema channel through these adapters | `UnsupportedOptionError`, declared in `refusedSessionOptions`. |

**Codex's native queue cannot carry a schema**, so `queue()` returns
`rejected: unsupported` when `outputSchema` is set. Send a new prompt after
the turn finishes instead. Codex can also start a new turn by itself for an
unfinished goal; those autonomous continuations have no schema. OAR does not
intercept or prevent native goals. A resumed thread's already queued native
inputs are likewise outside the OAR `turn/start` setting. Grok's setting is
also request-scoped; it does not promise a schema for autonomous work that
makes no OAR prompt request.

Only completed outcomes can carry `structuredOutput`. Absence and an
explicit native `null` differ. `promptAndWait`, `awaitTurnEnd`, status and
SessionView retain the same native value live and after record replay;
ordinary text and raw frames remain available.
Claude can complete without a structured value even with a schema when the
model never supplies one; hosts must check for the field, not just `kind`.
Hosts consuming Codex text must parse and validate it themselves when their
application needs a value conforming to the schema. Claude retry exhaustion
and Grok validation failures are `failure: "output_schema"` with the native
reason ([mapping](#the-mapping)).

[Native evidence, failure probes and limits](../../experiments/structured-output-2026-10-11.md).

## Additional directories

`SessionOptions.additionalDirectories` supplies extra workspace paths through
native settings. Relative paths resolve against `cwd`; duplicates are removed,
and `cwd` stays the primary directory. Omitted or empty adds no override.
This does not select a sandbox mode or promise filesystem isolation. Directory
existence, permissions and tool access remain the runtime's responsibility.
Loading project rules or instruction files in extra directories varies by
runtime and is not guaranteed by this option.

| Runtime | Native mapping | Resume |
|---|---|---|
| claude | `--add-dir` | Pass the list again for the new process. |
| codex | `thread/start.runtimeWorkspaceRoots`, with cwd first | `thread/resume.runtimeWorkspaceRoots`; the explicit list replaces native runtime roots, including roots from configuration. OAR checks the reply and fails an unconfirmed override. Sandbox mode is unchanged. |
| cursor | SDK `local.dirs`, cwd kept separately | Pass again to `Agent.resume`; current workspace metadata changes accordingly. Project-rule loading was not confirmed in the native probe. |
| kimi (KAP) | `POST /workspaces` (`additional_dirs`) → `workspace_id` on `POST /sessions` | A non-empty list is refused before launch: KAP resume ignores it. |
| kimi (ACP fallback) | ACP `session/new.additionalDirectories`, after capability advertisement | A non-empty list is refused before launch: the native resume ignores it. |
| opencode v2 | ACP `additionalDirectories`, after capability advertisement | Pass again; a cold resume without it does not restore the extra roots. |
| qwen | `--include-directories` | Pass the list again for the new process. |
| qoder | `--add-dir` | Pass the list again for the new process. |
| dsh | Linux and macOS from 0.2.2-rc.3 register each path on the session in its existing sandbox policy. Earlier releases and Windows refuse. | Each resume registers only the paths supplied for that session. |
| opencode v1, grok, antigravity, codebuddy, devin, factory, hermes, pi, pi-durable | Refused with `UnsupportedOptionError` | Same refusal. |

The unconditional refusals are declared in `Runtime.refusedSessionOptions`.
Kimi's resume restriction and OpenCode's release-line restriction are checked
at open; they are not unconditional runtime declarations. An ACP binary that
stops advertising the extension is refused before `session/new` or resume.

[Native evidence, boundaries and upgrade checks](../../experiments/additional-directories-2026-10-11.md).

## Session name

`SessionOptions.name` is the session's display name in the runtime's own UI
and session list, so a user who shares the runtime's home with a host can
tell the host's sessions from their own. A new session gets it. A resume
never replaces a name the session has, which may be one the user gave. The
name is set only once the open's own checks pass, so a refused open renames
nothing. A blank name, or one with a NUL character, is refused with
`UnsupportedOptionError` before anything starts, as invalid
`additionalDirectories` are.

| Runtime | Native mapping | Resume |
|---|---|---|
| claude | `--name` at launch | Left alone: `--name` on a resume replaces the session's name, and claude reports that name only once it has started (`session_title_changed`). |
| codex | `thread/name/set` once the thread is open | Set only when the `thread/resume` reply shows no name. |
| pi | a `session_info` entry, as pi's own `--name` writes it | Set only when the session never had one, so a name the user cleared stays cleared. |
| dsh | native `sessionTitle.rename` after opening checks | Preserve any native title; set only when none exists. |
| cursor, devin, factory, hermes, kimi, grok, antigravity, opencode, codebuddy, qwen, qoder, pi-durable | Refused with `UnsupportedOptionError` | Same refusal. |

Evidence: [`experiments/codex-session-name.ts`](../../experiments/codex-session-name.ts)
(codex 0.162.0) and the vendor tests
[`codex-session-name`](../../sea-trial/vendor/codex-session-name.vendor.test.ts),
[`claude-session-name`](../../sea-trial/vendor/claude-session-name.vendor.test.ts)
and [`pi-session-name`](../../sea-trial/vendor/pi-session-name.vendor.test.ts),
which read the name back through each runtime's own interface.

## Forking a session

`SessionOptions.fork` opens a NEW native session that starts as a copy of
the saved session `resume` names, so a host can branch a conversation (a
"new chat from this reply" button) without touching the original. The
opened Session reports the copy's own id; later resumes name that id, and
the source stays resumable on its own. `fork.through` cuts the copy after
one turn; omitted, the whole conversation is copied, which is the same as
cutting after the last turn. `fork` without `resume`, or a blank `through`
or one with a NUL character, is refused with `UnsupportedOptionError` on
`fork` before anything starts.

The anchor is runtime-native and opaque. Hosts read it from the root
`turn_ended` event's `forkAnchor` ([record stream](record-stream.md)), or
from `ViewTurn.forkAnchor` in the session view (`reduceSessionView`,
`@botiverse/oar/observe`), and never parse native frames for it. OAR
retains no records across processes, so a host that offers a fork on an
earlier process's turn keeps those records or the anchors itself. Only an
anchor of a turn the source holds is meaningful; one the runtime cannot
find fails the open with its own error. Claude and Codex keep the source's
anchors on the turns a fork copies, so an anchor read from the source also
forks the fork.

The fork's id is the runtime's own report, never assumed: claude must
confirm the id OAR assigned at open. Codex and OpenCode name the new session in their replies.

| runtime | native mapping | `through` anchor | missing anchor | token totals |
|---|---|---|---|---|
| claude | `--resume=<source> --fork-session --session-id=<OAR's new id>`, plus the hidden `--resume-session-at=<anchor>`; the open fails unless the private `get_status` answer reports that id | `uuid` of the turn's last root assistant message (an API-error failure's is the saved `API Error` message); none when that message holds a `tool_use` or a root `tool_result` follows it, on an aborted turn, or on one with no assistant message (a manual compaction) | `No message found with message.uuid of: <anchor>` at startup, an `Error` with that text | the fork's own, from the resume's `get_usage` baseline |
| codex | `thread/fork { threadId: <source>, lastTurnId?, excludeTurns: true, cwd, model?, … }`; the reply's `thread.id` is `Session.id` (one naming the source fails the open); effort set afterwards as on a resume | the turn id (the records' `spanId`), on completed, failed and aborted turns, manual compaction turns and goal continuation turns | `codex thread/fork failed: turn not found: <anchor>` | unreported for the whole Session: the fork's total includes the source's turns and codex sends no re-report to baseline it |
| opencode v2 | Advertised ACP `session/fork` returns the copy's `sessionId`. The source remains usable. [Native controls](../../experiments/opencode-fork/README.md) | none, only whole sessions | any `through` is refused before copying | from the copy's own prompts where reported |
| every other runtime and opencode v1 | refused | none | | |

**Other options on a fork.** They behave as on a resume of the source, not
as on a new session. A claude fork is a `--resume`, so `systemPrompt` and
`appendSystemPrompt` follow claude's `Runtime.resumedSessionOptions`
(a changed value takes effect at the next compaction; an omitted one keeps
the saved value until then). Exceptions: `name` names the copy as a new
session on both runtimes. A codex fork does not keep the source's model and
effort: without `model` and `effort` it runs the configured default, with
`mcpServers` (a `config` override) and without any override (0.169.0 and
0.169.1: a `gpt-5.2`/`high` source forked onto `gpt-5.1` with no effort),
so a host that wants the source's settings gives
them again. When a codex fork applies `baseInstructions` and
`developerInstructions` is untested; codex's `resumedSessionOptions`
describe `thread/resume` only.

**Turns that end on a tool call, aborted and failed turns.** Claude's
`--resume-session-at` keeps the history through a message and nothing
after it, so a fork through a `tool_use` drops the saved `tool_result` and
claude answers the dangling call with `[Tool result missing due to internal
error]` instead. A claude turn therefore gets no anchor when its last root
assistant message holds a `tool_use`, or a root `tool_result` follows it.
Observed on 2.1.323: an `outputSchema` turn completes on its
`StructuredOutput` call (the source's next prompt carried `Structured output
provided successfully`, a fork through the call carried the internal error);
an `error_max_turns` turn stops after a tool call (the source's next prompt
carried the tool's output, the fork the internal error); an abort that
interrupts a tool call (the source's `[Request interrupted by user for tool
use]` is lost). The rule also withholds the anchor (unit tests only, not
run against claude) for `error_max_structured_output_retries`, and would for
a budget limit or an interrupt OAR did not request that stops after a tool
call; an aborted claude turn gets no anchor even without a tool call. An API-error failure (observed: a 400 on the
turn's model request) is anchored on the synthetic `API Error` message
claude saves, and a fork through it carries what the source's next prompt
carried. Codex forks through a failed or an aborted turn (`interrupted`,
with the aborted tool output and `<turn_aborted>`) carry what the source's
next prompt carried. A turn in progress has no anchor yet.

**Compaction and goals.** A codex manual compaction turn and a goal
continuation turn (codex's own, with no client prompt) carry anchors, and
a fork through either carries what the source's next prompt carried
(0.169.1). A claude manual compaction ends a turn with no assistant
message, so it has no anchor; after it, a fork through a turn before the
compaction fails the open with `No message found with message.uuid of:
<anchor>`, as an unknown anchor does, while a fork through a later turn
carries what the source's next prompt carried (2.1.323). That error is not
silent; a host that offers forks on old turns of a compacted claude session
should expect it.

**A source open elsewhere.** Forking a source that is still open in another
live Session works on both: the fork copies the turns the source has saved,
and the source goes on without the fork's turns (claude 2.1.323, codex
0.169.1). Only one turn was saved and the source was idle at fork time; a
fork taken while the source is mid-turn is untested.

**Versions.** Claude's `--resume-session-at` is hidden and verified on
2.1.323 only; OAR does not gate it. A claude without the flag would refuse it
as an unknown option and exit, which fails the open (it is not silently
ignored); not observed on an older release. The fork's id is read back with
the private `get_status` request: 2.1.323 answers an unknown control
request with an error response (`Unsupported control request subtype`), so
a claude without `get_status` would fail the fork open with that text
(fail closed: `Session.id` would be unconfirmed; reasoned, no such release
was run). Codex `lastTurnId` arrived in 0.143.0 (schema bisection); an
earlier release would receive a field its schema does not have, which codex
is expected to ignore and copy the whole thread (reasoned, not run), so
`through` on them is `runtime_outdated` before the fork is sent. A fork
without `through` is sent the same way on every release (`thread/fork` is in
the 0.118.0 schema), but forks were run on 0.169.0 and 0.169.1 only.

A missing source is `SessionNotFoundError` on both, read with the resume's
words. Claude keeps rejecting `--fork-session` in `launchArgs` (use this
option), and with a fork also `--resume-session-at`. Codex forks carry no
`experimentalRawEvents` and are ordinary threads (not `ephemeral`, not
`attachToSource`). They do not send `deferGoalContinuation`: with
`goals: true` and an active goal on the source, codex may start the goal's
automatic continuation turn as the fork opens (untested). A codex fork
reports no token totals for its whole Session, not only before its first
turn (two turns of a fork carried no `tokens`, 0.169.1).

Evidence: [`session-fork.vendor.test.ts`](../../sea-trial/vendor/session-fork.vendor.test.ts)
runs claude (2.1.323) and codex (0.169.0, and 0.169.1 with the cases
below) against a scripted provider, with
a two-turn source and three forks (through the first turn, through the last,
whole). Each fork's id is new and the only one the runtime reports in its
frames; the source's native transcript is byte-identical after the forks
and it resumes with its own two turns; the history the provider receives
from the first-turn fork equals what the source's second prompt carried;
the last-turn fork, the whole fork and the resumed source carry the same
history; a fork resumes later under its own id, and forks again through a
source anchor. Further cases cover failed and aborted turns and the codex
model and effort; [`session-fork-cases.vendor.test.ts`](../../sea-trial/vendor/session-fork-cases.vendor.test.ts)
covers a source still open, claude `outputSchema` and `error_max_turns`
turns, the copy's claude name, compaction and codex goal continuation
turns, and codex token totals. A real claude login (haiku, 2026-11-17) answered "APPLE"
in a fork through the first of "remember APPLE", "remember BANANA", while
the source answered both and its transcript was unchanged. Codex `lastTurnId`
floor: bisected over the npm releases' generated app-server schemas
(`codex app-server generate-json-schema --experimental`): 0.142.5 has no
such field, 0.143.0 has it; `thread/fork` itself is in 0.118.0's.

## Refused session options

What a runtime cannot honor is refused, never dropped: `session()` rejects
with an `UnsupportedOptionError` whose `option` names the refused
`SessionOptions` key and whose message is the reason, rather than open a
session that quietly runs without it. A host may simply try and fall back
on that error, and tells it from a failed login or a network error without
reading the message.

`Runtime.refusedSessionOptions` declares, before any session opens, the
`SessionOptions` a runtime refuses when given (`env`, `mcpServers`, `disallowedTools`, `launchArgs`, `additionalDirectories`: a
non-empty one; `userConfiguration`: any exclusion; `partialUserConfiguration`: a proper nonempty subset; `goals`, `endTurnProcessesOnAbort`: `true`; `fork`: any value; `nativeMemoryDefault`: `"off"`; `sessionLogUpload`: `"off"`; `nativePermissions`: `"inherit"`), each with that reason. The adapter checks the same map, so
the declaration and the refusal cannot drift
(`tests/refused-session-options.test.ts`). A host leaves a declared option
out instead of naming runtimes. `outputSchema` is considered given even
when it is an empty object. Another value of an option is declared on its own
because a host can know it in advance: `mcpServerCredentials`, an
`mcpServers` entry carrying a credential (a non-empty `env` on a stdio
entry, non-empty `headers` on an http one). Its error names `mcpServers`
and ends with the entries' names
([#392](https://github.com/botiverse/oar/issues/392)).

A runtime may accept a credentialed entry only when OAR has verified that
the values reach only the designated MCP server. The values must stay out
of process arguments and the agent's tool environment. A private startup
file is permitted if it is removed after native initialization and before
the first turn can run. A runtime that cannot meet this rule or whose
isolation is unverified declares `mcpServerCredentials`. Every
`serveMcpTools` entry carries a bearer token, so the same rule applies to it.

`goals: true` is refused everywhere except Codex and DSH ([native goals](#native-goals)),
`endTurnProcessesOnAbort: true` everywhere except Codex in an isolated
app-server and Grok ([ending a turn's processes](#ending-a-turns-processes-on-abort)),
`nativeMemoryDefault: "off"` everywhere except Qwen `>= 0.26.0`
([native memory default](#native-memory-default)),
`sessionLogUpload: "off"` everywhere except DSH `>= 0.2.1-rc.5`
([session log upload](#session-log-upload)),
`nativePermissions: "inherit"` everywhere except Codex
([native permissions](#native-permissions)),
and `userQuestions: "host"` everywhere except Claude and Codex
([user questions](#user-questions)),
for want of a verified way to end one aborted turn's processes while the
session stays usable (in the host process, no process tree of its own to
read), a below-user default settings layer, a verified vendor session-log
upload switch, a verified per-session native permissions inherit path, or a verified way for a host to answer questions. Claude and Codex accept forks through a chosen turn. OpenCode v2
can copy a whole session. Other adapters refuse `fork`
([forking a session](#forking-a-session)). `modelRequests: "latest"` is accepted
by Claude (`>= 2.1.274`) and Pi SDK, and refused elsewhere
([model-request.md](model-request.md)). The table omits all seven, apart
from Codex's shared-placement refusal.

`dshProvider` is DSH-only: every other runtime refuses it. It declares the
provider, wire, endpoint, credential variable and models a DSH session runs, in
`llm-pi-ai`'s own vocabulary, through OAR's private invocation `--patch` — no
file under `DSH_HOME` is read or written, and the session's bridge rejects the
open when DSH did not apply it ([host-declared
provider](../runtimes/dsh.md#host-declared-provider)).

`piProvider` and `piCompaction` are Pi-only: every other runtime refuses both.
Pi honors the provider in both of its execution modes (the RPC child registers it
from OAR's own extension before the model resolves) and refuses the compaction
budget in the RPC mode, whose child compacts from the settings files it loads and
whose extension API only reads settings back (`pi.getSettings()` returns a copy
with no setter, verified against the real bundled child in
[the RPC compaction-channel test](../../sea-trial/vendor/pi-rpc-compaction-channel.vendor.test.ts)).
They let a
host declare the gateway provider and model a session runs, and that session's
compaction budget, without writing Pi's `models.json` or the user's settings
file ([host-declared provider](../runtimes/pi.md#host-declared-provider-and-compaction-budget)).
A runtime that does not list them in `refusedSessionOptions` must honor them.
These refusals have one reason wherever the table lists them: `serviceTier`,
no verified per-session tier setting and readback; `outputSchema`, no
verified final-output schema channel; `name`, no verified session name
setting (pi-durable has no session name at all); `additionalDirectories`,
no verified effective additional workspace directory channel. The why
column gives the rest. `userConfiguration: "exclude"` refusals are explained
in [user configuration](#user-configuration).

| runtime | refuses | why |
|---|---|---|
| cursor | `systemPrompt`, `appendSystemPrompt`, `env` (in process only), `launchArgs`, `serviceTier`, `outputSchema`, `name` | the SDK's local agent fails a run given a system prompt and has no append; in process it runs in the host process with no environment or command line of its own; in subprocess mode `env` is its child's ([execution modes](../runtimes/cursor.md#execution-modes)). MCP credential isolation verified on SDK 1.4.1 Linux x64 ([isolation measurements](../../experiments/mcp-credential-admission/README.md)) |
| codebuddy | `appendSystemPrompt`, `serviceTier`, `additionalDirectories`, `outputSchema`, `name`, `userConfiguration: "exclude"` | no verified private prompt-append input; replacement uses a private file ([mapping](../runtimes/codebuddy.md)) |
| devin | `mcpServerCredentials`, `systemPrompt`, `appendSystemPrompt`, `disallowedTools`, `serviceTier`, `additionalDirectories`, `outputSchema`, `name`, `userConfiguration: "exclude"` | `devin acp` has no verified prompt or tool-denial channel, and `initialize` advertises `sessionCapabilities.additionalDirectories` without verified primary-cwd and tool scoping ([mapping](../runtimes/devin.md)). Existing storage evidence covers only its SQLite database. [Isolation measurements](../../experiments/mcp-credential-admission/README.md) |
| hermes | `systemPrompt`, `appendSystemPrompt`, `disallowedTools`, `launchArgs`, `serviceTier`, `additionalDirectories`, `outputSchema`, `name`, `userConfiguration: "exclude"`; `mcpServerCredentials` on every release except 0.23.3 | the gateway viewer exposes no prompt, tool-denial or arbitrary launch-argument channel, and `additionalDirectories` is not advertised. 0.23.3 is the one release whose editor MCP credential handling OAR measured (a fingerprint in the store, the values in the owner's memory), so only there does an entry with `env` attach; the release-specific refusal is in `sessionCapabilities(installation)`, not in the static map ([mapping](../runtimes/hermes.md#session-mcp-servers)) |
| kimi | `systemPrompt`, `disallowedTools`, `serviceTier`, `outputSchema`, `name`, `userConfiguration: "exclude"` (and `appendSystemPrompt` conditionally on ACP fallback) | KAP sends `append_system_prompt` on `POST /sessions` and `:resume`; ACP fallback (`< 2.7.3` non-botiverse) refuses `appendSystemPrompt` via `sessionCapabilities` and lacks session prompt/agent-profile or tool-denylist overrides ([audit](../runtimes/kimi.md#models-instructions-and-context)) |
| antigravity | `disallowedTools`, `systemPrompt`, `serviceTier`, `additionalDirectories`, `outputSchema`, `name`, `mcpServerCredentials`, `userConfiguration: "exclude"` | the CLI adapter has no verified system prompt replacement channel (append is supported) ([audit](../runtimes/antigravity.md#models-instructions-and-context)); it would store an entry's `env` and `headers` values in plain text in its conversation database ([antigravity](../runtimes/antigravity.md#session-mcp-servers)) |
| grok | `disallowedTools`, `serviceTier`, `additionalDirectories`, `name`, `userConfiguration: "exclude"` | the top-level CLI denylist is not forwarded to `agent stdio`; replacing the selected agent profile is not a tool overlay |
| opencode, both lines | `disallowedTools`, `serviceTier`, `outputSchema`, `name`, `userConfiguration: "exclude"` | agent permissions can override global denies; permission names do not consistently match tool names |
| pi-durable | `systemPrompt`, `env`, `launchArgs`, `serviceTier`, `mcpServers`, `disallowedTools`, `additionalDirectories`, `outputSchema`, `name`, `userConfiguration: "exclude"` | native instructions append only; host-owned environment; no process arguments or verified per-conversation tier/MCP/tool-denial mapping |
| pi | `launchArgs`, `serviceTier`, `additionalDirectories`, `outputSchema`, `userConfiguration: "exclude"` | it runs in the host process through its SDK, with no command line. Subprocess mode delivers startup config (including MCP server credentials) once over the private fd 3 pipe at startup instead of writing it to disk ([pi](../runtimes/pi.md#optional-native-rpc-process)). |
| qwen | `serviceTier`, `outputSchema`, `name`, `userConfiguration: "exclude"` | no verified tier, structured-output, session-name or user-configuration exclusion channel |
| dsh | `launchArgs`, `serviceTier`, `outputSchema`, `userConfiguration: "exclude"` | Launcher overlays can disable the bridge; root `agentOptions.outputSchema` is ignored while the native child API supports it; the other options remain unverified through the bridge ([mapping](../runtimes/dsh.md#session-options)) |
| factory | `serviceTier`, `outputSchema`, `name`, `additionalDirectories`, `disallowedTools`, `userConfiguration: "exclude"` | no tier; structured output, session titles and tool denials not yet verified; no extra-directory or user-configuration exclusion channel ([mapping](../runtimes/factory.md#session-options)) |
| qoder | `serviceTier`, `outputSchema`, `name`, `userConfiguration: "exclude"` | no verified tier, structured-output, session-name or user-configuration exclusion channel |
| codex | `userConfiguration: "exclude"`; `endTurnProcessesOnAbort: true` only with shared placement | temporary clean homes break shared history paths after cleanup ([evidence](../runtimes/codex.md#user-configuration)); a shared app-server's process table does not say which session's turn started a process |
| claude | `goals: true`, `endTurnProcessesOnAbort: true` | no structured native goal controls on the chosen transport; other value-specific refusals are described on its runtime page ([Isolation measurements](../../experiments/mcp-credential-admission/README.md)) |

`mcpServers` is refused until a runtime's channel is shown to make its agent
call an attached server's tool, with the evidence on its runtime page
([#170](https://github.com/botiverse/oar/issues/170)). Where it is taken:

| runtime | channel | stdio | http | resume | a name the user's config also has |
|---|---|---|---|---|---|
| claude | `--mcp-config <path>`: a 0600 FIFO removed once claude has read it (or, where FIFOs are unavailable such as Windows, a 0600 file inside a 0700 dir deleted right after `initialize`); strict host-only configuration when user configuration is excluded | yes | yes | the flag again | the session's server replaces the user's for that process ([claude](../runtimes/claude.md#session-mcp-servers)) |
| codex | `config.mcp_servers` on `thread/start` and `thread/resume` | yes | yes | the override again | merged into the user's entry field by field; oar's `command` / `url`, `args` and `enabled = true` win ([codex](../runtimes/codex.md#session-mcp-servers)) |
| cursor | the SDK's `mcpServers` on `Agent.create` and `Agent.resume` (in subprocess mode, passed over Node IPC rather than argv or env) | yes | yes | the record again | not re-checked live; against a stand-in backend the inline entry won ([cursor](../runtimes/cursor.md#session-mcp-servers)) |
| grok | ACP `mcpServers` on `session/new` and `session/resume`; the model reaches the tools through grok's `use_tool` | yes | yes | the param again | the session's replaces the user's `config.toml` entry; the user's others stay ([grok](../runtimes/grok.md#session-mcp-servers)) |
| codebuddy | ACP `mcpServers` on `session/new` and `session/load` | yes | yes | the param again | conflict precedence unverified; credentialed new/resumed calls and no native HOME persistence verified ([mapping](../runtimes/codebuddy.md)) |
| devin | credential-free ACP `mcpServers` on `session/new` and `session/load` | yes | yes | the param again | conflict precedence unverified; HTTP/stdio env and credentials are not persisted in `~/.local/share/devin` SQLite ([devin](../runtimes/devin.md#session-mcp-servers)) |
| hermes | ACP `mcpServers` on `session/new` and `session/resume`; the gateway freezes the editor tool list per session | yes | no: `initialize` advertises no `mcpCapabilities.http` | the param again | a changed editor list applies from the next turn; on 0.23.3 a changed list re-spawns the server under the new `env` values, and the store keeps the fingerprint, schemas and names only ([hermes](../runtimes/hermes.md#session-mcp-servers)) |
| kimi | `mcp_servers` on `POST /sessions` and `POST /sessions/{id}:resume` (KAP), or ACP `mcpServers` on `session/new` and `session/resume` (ACP fallback) | yes | yes | the param again | the session's replaces the user's `mcp.json` entry; the user's others stay ([kimi](../runtimes/kimi.md#session-mcp-servers)) |
| opencode | ACP `mcpServers` on `session/new` and `session/resume`, held by that opencode process | yes | yes | the param again | the session's replaces the user's `mcp` entry for that process (a session server that fails to start removes it); the user's others stay ([opencode](../runtimes/opencode.md#session-mcp-servers)) |
| antigravity | ACP `mcpServers` on `session/new` and `session/resume`; CLI worker mode exposes direct `mcp_<server>_<tool>` calls (user-configured servers remain lazy via `call_mcp_tool`). An entry with `env` or `headers` is refused (`mcpServerCredentials`, above) | yes | yes | the param again | the session's replaces the user's `mcp_config.json` entry; the user's others stay ([antigravity](../runtimes/antigravity.md#session-mcp-servers)) |
| qwen | per-session `initialize.mcpServers` (stdio command/args/env, HTTP `httpUrl`/headers) | yes | yes | the entries again | see [qwen](../runtimes/qwen.md) |
| qoder | `--mcp-config <path>`: a 0600 FIFO removed once Qoder has read it (on Windows, a 0600 file removed once `initialize` completes) | yes | yes | the flag again | see [qoder](../runtimes/qoder.md) |
| dsh | bridge stdin carries in-memory native MCP plugin configurations, checked active before open | yes | yes | supply entries again; omitted entries are absent | a native namespace collision refuses open ([dsh](../runtimes/dsh.md#session-mcp-servers)) |
| factory | `mcpServers` on `initialize_session` and `load_session` (stdio `env` as a record, http `headers` as name/value pairs); droid offers the tools as `<server>___<tool>` | yes | yes | the param again | not measured ([factory](../runtimes/factory.md#session-mcp-servers)) |
| pi | in process: `pi.registerMcpServer` inline extension; subprocess: one-time fd 3 pipe delivery to `pi.registerMcpServer`; tools declared directly | yes | yes | registered again | oar's pi loads no `mcp.json`; a name another extension registered fails the open ([pi](../runtimes/pi.md#session-mcp-servers)) |

Evidence: the vendor tests run the real CLI (pi: the bundled SDK) against a
scripted provider whose model calls a stdio and an http echo server's tool, on
open and on a resume in a new process, and assert the provider received what
only that server writes, carrying the credential the entry gave it:
[`mcp-servers.vendor.test.ts`](../../sea-trial/vendor/mcp-servers.vendor.test.ts)
(claude, codex), [`mcp-servers-pi.vendor.test.ts`](../../sea-trial/vendor/mcp-servers-pi.vendor.test.ts)
and [`mcp-servers-acp.vendor.test.ts`](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts)
(grok, kimi, opencode, antigravity: each CLI pointed at aimock from a fresh
home, [harness](../../sea-trial/harness/aimock-acp.ts)). The same tests cover the name clash and check that
no record holds a credential. The recordings are
`tests/replay/fixtures/{claude,codex,pi}-mcp-echo.raw.jsonl`.

DSH command/args controls, including startup failure and child cleanup, are in
[`dsh-mcp.vendor.test.ts`](../../sea-trial/vendor/dsh-mcp.vendor.test.ts).
The [credentialed transport test](../../sea-trial/vendor/dsh-mcp-credentials.vendor.test.ts)
calls a stdio tool and a bearer-authenticated HTTP tool on the first turn. The
[Linux audit](../../experiments/mcp-credential-admission/README.md#dsh-bridge-stdin)
covers credential isolation and persistence on both tested DSH versions.

CodeBuddy's credentialed stdio/HTTP invocation and post-exit persistence audit
are in [`codebuddy.vendor.test.ts`](../../sea-trial/vendor/codebuddy.vendor.test.ts).
Its same-name conflict precedence and live tool-list updates remain unverified.

A list naming a server twice, or with an empty name, is a plain error before
anything starts, as is a name codex (`^[\w:@/.-]+$`) or pi (`^[\w-]+$`, and
two names pi folds into one tool namespace) would not take. The names
`__proto__`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__` and
`__lookupSetter__` are an `UnsupportedOptionError` on `mcpServers` on every
runtime, codex and pi (which take them) included, so one rule holds: claude
2.1.299 drops all five without a word, kimi, opencode and claude 2.1.296 drop
`__proto__`, and grok announces none of them, while the session opens as
usual ([#395](https://github.com/botiverse/oar/issues/395)). A transport a
runtime cannot attach is an `UnsupportedOptionError` on `mcpServers` too: an
http entry on an ACP agent whose `initialize` declares no
`mcpCapabilities.http`; every runtime above attaches both.

### Conditional refusals

The remaining refusals depend on a value, the installed version or the
session itself, so `refusedSessionOptions` does not declare them; each is
an `UnsupportedOptionError`.

OpenCode v1 carries prompt options through native inline configuration. An
already-defined `OPENCODE_CONFIG_CONTENT` refuses either prompt option, and
an empty replacement is refused because native OpenCode selects its built-in
prompt for that value ([evidence](../runtimes/opencode.md#models-effort-instructions-and-context)).
OpenCode v2 uses the same inline configuration with its own fields and
refuses each prompt option below the release measured to apply it:
`appendSystemPrompt` from 2.0.30, `systemPrompt` from 2.2.0
([evidence](../runtimes/opencode.md#v2-prompt-options)).
At open, OpenCode v1 also refuses a non-empty `additionalDirectories` list
([additional directories](#additional-directories)).

Grok 1.0.70 refuses any explicitly supplied append-only prompt on resume,
even unchanged text, since native `rules` is not reapplied without an override
and OAR cannot compare the saved value. It also refuses a blank `systemPrompt`
on creation and resume, even alongside an append, since it treats that as
omitted. `systemPrompt` and `appendSystemPrompt` use separate native
override/rules fields; together they are supported on creation and resume
([request evidence](../runtimes/grok.md#models-and-instructions)).

Kimi (ACP fallback), opencode, antigravity and devin refuse a `resume` that names another directory than
the one their `session/list` says the session lives in (option `cwd`): they
would run the session in its own directory instead, and only the runtime
knows that directory. Kimi (KAP) calls HTTP `GET /sessions/{id}` directly and
throws the same directory guard when `existing.cwd` differs. Their directory
guard throws the public
`ResumeCwdError`, extending `UnsupportedOptionError` with `option: "cwd"`
and the original message; its `name` stays `"UnsupportedOptionError"`. It
carries `sessionId`, `requestedCwd` and a typed
`reason`; only `other_cwd` includes `savedCwd`.

| Directory check | `ResumeCwdError.reason` |
|---|---|
| Completed listing omits the id | `not_listed` |
| Observed saved directory differs | `other_cwd` |
| Listed id has no non-empty string cwd | `cwd_unreported` |
| Missing list capability, malformed page or invalid/repeated cursor | `listing_unavailable` |

DSH's saved-header directory mismatch and Factory's `load_session` answer
naming another cwd also use `other_cwd`; DSH's missing header directory
still refuses the separate `resume` option. Native listing
and header-read errors keep their own types. `not_listed` is not proof that
history is gone: agy 1.5.0 omits sessions closed before their first prompt.
No replacement session is started by OAR
([details and evidence](../runtimes/resume-cwd.md)).

An ACP runtime whose session advertises no `thought_level` config option
has no effort channel, so it refuses `effort` once its handshake shows that
(`shared/acp/effort.ts`, `tests/acp/acp-session-effort.test.ts`).
Antigravity CLI 1.5.0 advertises `thought_level` in this category for its grouped model families.
The menu belongs to the model in effect: opencode offers one only for a
model with variants, so after a requested model switch the switch's answer
is read, not the open's ([env] opencode 1.18.30). A level a runtime does not
offer is a plain error naming the level, not this one.

## Resumed session options

`Runtime.resumedSessionOptions` lets a host choose how to resume before
opening a session, without a runtime-name switch. It is a partial map keyed
by `SessionOptions`; this release declares only `systemPrompt` and
`appendSystemPrompt`. Each entry has two independent dimensions:

- `provided`: a value **different from the saved value** takes effect
  `immediate`ly or at `next_compaction` (the next native compaction).
- `omitted`: `saved` keeps the saved value; `default` means what a new session
  without that option would get, including current user configuration;
  `saved_until_compaction` keeps the saved value until native compaction,
  then returns to that `default`.

An absent entry means untested. It establishes neither support nor refusal.
Refusals stay in `refusedSessionOptions` and conditional
`UnsupportedOptionError`s; the declaration describes an accepted open, so
value-specific and active-run restrictions still apply. OAR does not compare
prompt strings, inject instructions into the first input, or fork a session.
A host needing an immediate reminder can choose its own input policy using
this declaration; that is separate from changing the system prompt.

| Runtime / option | Different supplied value | Omitted | Declaration / evidence |
| --- | --- | --- | --- |
| Claude, both prompts | Next native compaction | Saved until compaction, then default | Both declared; 2.1.316, manual `/compact` |
| Codex, `systemPrompt` | Immediate | Saved, including after compaction | Declared; 0.166.0 |
| Codex, `appendSystemPrompt` | Next native compaction | Saved until compaction, then default | Declared; 0.166.0, local automatic compaction |
| Qwen, both prompts | Immediate | Default, including after compaction | Both declared; 0.26.5, native `/compress` |
| Pi SDK/RPC, both prompts | Immediate | Default, including current project resources and after compaction | Both declared; 1.4.0, native automatic compaction |
| Pi Durable, `appendSystemPrompt` | Immediate | Saved, including after compaction | Declared; 1.5.2, native automatic compaction. Changing settings while adopting an active run is refused. Replacement is always refused. |
| Cursor, Kimi | Both refused | Not applicable | Refusals declared, no resume entries |
| Grok | Replacement and append together apply immediately; append-only resume is refused | Saved; append-only retention also verified across native compaction (1.0.70) | Conditional; no resume entries; host rule below. [Details](../runtimes/grok.md#models-and-instructions) |
| OpenCode v1 | Both reapplied through native inline configuration | Omission across compaction untested | Version-dependent; no resume entries. [Details](../runtimes/opencode.md#models-effort-instructions-and-context) |
| OpenCode v2 | Both apply immediately, a resume included | An omitted append stays in the saved system text with a native retraction ("no longer apply"); omitted replacement untested | Version floors (2.0.30 append, 2.2.0 replacement); no resume entries. [Details](../runtimes/opencode.md#v2-prompt-options) |
| Antigravity, `appendSystemPrompt` | Immediate when native capability is advertised | Default in the measured resume control | Capability-dependent; no resume entry. Replacement refused. [Details](../runtimes/antigravity.md#models-instructions-and-context) |
| Qoder | Immediate (1.1.78 request-construction evidence) | Untested | No resume entries; [details](../runtimes/qoder.md#oar-mapping) |
| DSH, both prompt options | Immediate | Native default | Declared; 0.2.1-rc.5 and 0.2.2-rc.1, Linux with local providers. Literal scoped registration; native children use their own defaults. Compaction unmeasured ([evidence](../runtimes/dsh.md#system-prompts)) |
| Devin | Both refused | Refused | No resume entries; both prompt options are refused at open |
| Hermes | Both refused | Refused | No resume entries; both prompt options are refused at open |
| Factory | Refused on resume (`load_session` takes no prompt) | Refused on resume | No resume entries; new sessions take both ([details](../runtimes/factory.md#session-options)) |
| CodeBuddy | Replacement reapplied; append refused | Replacement omission untested | No resume entries |

**Supply the current prompts on every Claude/Codex resume.** Claude's saved
prompt snapshot and Codex's saved developer instructions can govern the
first turn while the current open's options govern later turns after
compaction. Omitting them is not a reliable way to keep them. Codex's
replacement prompt is the exception: omission retains saved base instructions.
Grok needs a different host rule: if only append was configured, **omit
`appendSystemPrompt` on resume** to keep its saved value, including after
compaction; supplying it again is refused ([conditional refusals](#conditional-refusals)).
To change it, also supply `systemPrompt`; OAR invents no replacement.

Vendor regressions read the runtime declarations and check supplied and
omitted values before and after native compaction, from raw main provider
requests and native completion records:
[Claude/Codex](../../sea-trial/vendor/resume-system-prompt.vendor.test.ts)
(Claude reports only an ending boundary, Codex start and end; the Codex
fixture triggers local automatic compaction with scripted usage, not an OAR
control, and remote compaction under a ChatGPT login is unverified),
[Qwen/Pi](../../sea-trial/vendor/resume-fresh-prompts.vendor.test.ts) and
[Pi Durable](../../sea-trial/vendor/pi-durable.vendor.test.ts) (unique
scripted summaries must appear in fresh main requests after compaction; Qwen
must also report its native successful compression and a smaller token
count). The sequential controls track the current saved value, including one
supplied on a previous resume. A
[registry-wide test](../../tests/resumed-session-options.test.ts) fixes the
measured runtime/option inventory and rejects overlap with refused options,
so a vendor behavior change fails the declared contract.

## Host-served tools

Tools the host implements itself reach the agent through `mcpServers` too,
not through a channel of their own. `serveMcpTools({ name, tools })` serves
them from a streamable HTTP MCP server inside the host process, on
`127.0.0.1` behind a random bearer token, and returns `close()` and an `mcpServers`
entry containing the HTTP URL, authorization header, name and
`origin: "serveMcpTools"`. Codex and Grok use the origin to wait for native
startup during open. Claude, Codex, Cursor, Pi SDK, Pi RPC, Grok, Kimi, OpenCode,
CodeBuddy, DSH, Factory, Qwen and Qoder accept the entry. Devin, Antigravity
and Hermes refuse an entry with `headers` (`mcpServerCredentials`); Hermes
already refuses every HTTP entry (no advertised `mcpCapabilities.http`), so
its `mcpServerCredentials` covers stdio `env` on releases other than the one
measured. Pi Durable refuses `mcpServers`.
A host tells before opening:
served tools attach unless `refusedSessionOptions` declares `mcpServers` or
`mcpServerCredentials`. The runtime must reach the host's loopback address,
which holds for every runtime OAR starts on this machine or runs in this
process.

A `HostTool` may carry MCP `annotations`, sent unchanged in `tools/list` and
absent when not given. OAR neither validates nor acts on them; runtimes do.
These are the host's declarations: a runtime may skip approval based on the
hints, so a host should declare only what is true of the tool.
Codex with `-c sandbox_mode="read-only"` (probed on 0.161.0) refuses an
unannotated served tool ("MCP tool call requires approval, but approval policy
is never") but calls one marked `readOnlyHint: true`, or `destructiveHint:
false` with `openWorldHint: false`, while the sandbox still blocks the agent's
own file writes. This is a versioned observation of Codex's approval policy,
not a guarantee that a runtime will accept an annotated tool. The
[native Codex regression](../../sea-trial/vendor/codex-tool-annotations.vendor.test.ts)
(Codex 0.166.0, Linux, 2026-11-05; it runs in the existing Codex vendor CI
jobs) checks the unannotated refusal, the actual `readOnlyHint: true` handler
call and its result reaching the model, and an `apply_patch` write refused
under the same read-only policy. A full-access control executes the same calls
and writes the file, so a malformed call cannot masquerade as a sandbox
refusal. Both controls use `approvalPolicy: never` and a scripted local
provider, without a login or model quota.

The server answers `initialize`, `ping`, `tools/list` and `tools/call` with
JSON, single or batched, and `notifications/cancelled` aborts the call's
`signal`. Each `initialize` opens its own MCP session (`mcp-session-id`), so
sessions sharing one served set never cancel each other's calls. It refuses
an `Origin` other than a loopback one, as MCP asks of local servers. A
handler's thrown error becomes an `isError` result carrying its message,
which the model sees as a failed tool call; an unknown tool is a JSON-RPC
error. Server and tool names are checked up front against the strictest
runtime's rules (`^[\w-]+$`, tools `^[\w-]{1,64}$` and unique), and a
server name is none of the five reserved ones above.

`instructions`, guidance across the tools (what the group is for, how the
tools work together), is returned as the `initialize` result's
`instructions` ([#378](https://github.com/botiverse/oar/issues/378)). Whether
the model sees it is the runtime's own choice: claude, codex, opencode and
grok hand it to the model; pi and kimi do not, so on those, guidance the
model must have belongs in the tool descriptions. Pinned per runtime by the
vendor test below ([env] 2026-10-13: claude 2.1.292, codex 0.162.0, pi
1.1.0, opencode 1.18.30, kimi 2.1.1, grok 1.0.50).

Native host-tool channels (codex `dynamicTools`, claude's in-process SDK
MCP, pi's custom tools) are not used: one MCP server reaches every runtime
above, and none of those channels adds a capability MCP lacks
([#341](https://github.com/botiverse/oar/issues/341)).

**Changing the tools mid-session** ([#399](https://github.com/botiverse/oar/issues/399)).
`served.setTools(tools)` replaces the served set (same name rules) and sends
`notifications/tools/list_changed` on every open stream: a client's GET with
`Accept: text/event-stream` opens one, which carries only that notification
and a keep-alive comment every 15 s; `initialize` declares
`tools.listChanged`. A call already running finishes with the tool it
started with; a call to a tool no longer served is an unknown tool. What a
running session does with the change is the runtime's choice, declared
before opening as `Runtime.mcpToolsListChanged` and judged by the session's
next model request. Every client below opened the stream and heard the
notification:

| declaration | runtimes | the next model request |
|---|---|---|
| `full` | pi, opencode (both lines) | offers the new set: added tools appear, removed ones disappear (opencode 2.x: a system update) |
| `additions` | claude | adds new tools; removed tools' already loaded schemas remain offered, though search withdraws their names and calls fail as unknown tools ([2.1.304 evidence](../../experiments/runtime-version-checks/2026-10-20.md#claude-21304)) |
| `none` | codex, hermes, kimi, grok, antigravity CLI | keeps the opening set; the client never lists again (grok's `use_tool` answers "Tool not found" for an added tool; Hermes applies a changed editor list from the next turn) |

pi-durable takes no `mcpServers` and declares nothing; codebuddy, cursor,
devin, dsh, factory, qwen and qoder take it but are unmeasured, so they declare nothing either. The
declaration covers any attached MCP server that announces a change, so
antigravity's matters only for credential-free servers: a `serveMcpTools`
entry never attaches there. A change a session does not take applies when
the host opens its next session. Measured [env] 2026-10-14: pi ^1.2.0, opencode 1.18.30, 1.19.0 and 2.0.29,
claude 2.1.299, codex 0.162.0 and 0.162.1, kimi 2.1.1,
grok 1.0.52 ([probe](../../experiments/mcp-tools-list-changed.ts),
[vendor test](../../sea-trial/vendor/mcp-tools-list-changed.vendor.test.ts));
Antigravity CLI 1.5.0 with the same declaration-driven provider/catalog check
([migration](../../experiments/antigravity-cli-acp-2026-11-05.md)).

Evidence: [`serve-mcp-tools.vendor.test.ts`](../../sea-trial/vendor/serve-mcp-tools.vendor.test.ts)
runs the real claude, codex and pi (in CI) and opencode, kimi and grok
(locally) against a scripted provider whose model calls a tool the test
process serves; the provider receives the words only the host's handler
writes, and no record holds the bearer token.
[`tests/mcp-serve-tools.test.ts`](../../tests/mcp-serve-tools.test.ts) pins
the protocol, authorization, cancellation, `setTools` and `close()`.

## ACP opening deadlines

All built-in ACP session adapters give `initialize` its own 60-second
response deadline, starting when the spawned transport sends that request.
The internal `AcpSessionProfile.initializeTimeoutMs` can override only that
phase. It is independent of `requestTimeoutMs`, whose default remains
15 seconds for other bounded requests. Because `session/load` replays
persisted session history before answering, it gets a 60-second default
deadline (at least `requestTimeoutMs` when unset;
`AcpSessionProfile.sessionLoadTimeoutMs` can override it, independent of
`requestTimeoutMs` and `sessionStartTimeoutMs`). Existing profile overrides remain:
Antigravity, CodeBuddy, Devin, Grok, Kimi and OpenCode use 30 seconds for
ordinary bounded requests; Hermes uses 60 seconds because the gateway connects to its daemon and mounts the session; Kimi gives `session/new` and `session/resume`
630 seconds for native SessionStart hooks. Each phase gets its own budget,
so a slow initialize does not consume authentication or session creation
time; post-open readiness checks (such as Grok's served-MCP discovery
in `waitForOpenReadiness`) share the opening method's deadline.
Isolated and shared connections use the same initialization rule.

A timeout rejects opening with an `AcpError`, `kind: "timeout"`, the
`method` and `timeoutMs`; its message names the phase and wait, for example
`ACP request initialize timed out after 60000ms`. It never turns silence
into success or starts a retry. The failed opening still cleans up its
process; native errors and early process exit still fail immediately.
Prompts remain governed by cancellation, and account/model queries retain
their separate whole-operation deadlines.

The [November 16 Windows Grok control](../../experiments/grok-startup/README.md#windows-result-november-16)
used Grok 1.0.70, Node 24.22.2 and isolated synthetic configuration, without
real accounts or model calls. Four first starts in new HOME directories
needed 8.36 to 11.49 seconds to answer initialize; four repeats in those
homes needed 0.389 to 0.399 seconds. All eight answered before 15 seconds.
Earlier suite failures included three replies at 15.18 to 16.49 seconds
and seven processes with no stdout before cleanup. Cold-start overhead
motivates a separate 60-second initialization default for every ACP
runtime, not a Grok-specific retry. The seven unanswered cases remain
unexplained; this successful control does not show whether they would
finish within 60 seconds. CPU sampling does not establish their cause.

## ACP opening process failures

If an ACP child exits before opening completes, the error retains its transport
error type and exit code and includes the native signal and a bounded stderr
tail (at most 8 KiB before redaction), also available as its diagnostic cause.
Explicit session and MCP credentials and recognizable key/JWT shapes are
redacted in both the message and cause. Authentication queries continue to hide
all native diagnostics. Request timeouts and native RPC refusals retain their
existing error classification.

## Missing resume targets

`session({ resume })` rejects with the exported `SessionNotFoundError` only
when the evidence below identifies a missing native conversation. It has
`name: "SessionNotFoundError"`, `sessionId` (the requested id), and
`cause: { method, native }` under the same credential-redaction rules as other
open errors. It is not a `FailureClass`: no turn exists yet. A host can
separate a missing resume target from authentication, model, quota, transport,
and other failed opens without parsing messages. Other failures keep their
existing types and causes; OAR never starts a replacement conversation.

| Runtime | Evidence required | Scope of "not found" |
|---|---|---|
| grok | Resume/load error `data.code === "FS_NOT_FOUND"` | This cwd, including a real id saved under another cwd. |
| factory | `load_session` error `code === -32004` ("Session not found") | The active HOME; a session saved for another cwd is refused (`ResumeCwdError`, `other_cwd`). |
| cursor | SDK error `code === "agent_not_found"` from `Agent.listRuns` or `Agent.resume` | Not found by the SDK with this configuration; the 1.0.37 probe had no `CURSOR_API_KEY`, and did not test a real id. |
| pi | OAR's `SessionManager.list(cwd, sessionDir)` lookup has no matching id | This cwd and agent directory, including a real id saved under another cwd. The cause reports the lookup scope and count, not an invented native error. |
| pi-durable | `Harness.conversation(id)` returns `undefined` for a valid native numeric id | The host's Harness and storage. Malformed ids and failed storage queries retain their ordinary errors; no replacement is created. |
| dsh | `sessionPersistence.open` throws `SessionPersistenceNotFoundError` | The active `DSH_HOME`, across working directories. |
| claude | During resume, before the `initialize` answer, `result/error_during_execution` with `errors[0]` starting `No conversation found with session ID` or reporting `is not a UUID and does not match any session title` | The active Claude configuration; exact prose is the last resort. |
| codex | `thread/resume` JSON-RPC error `-32600` with message starting `no rollout found for thread id` | The active Codex storage/configuration; exact prose is the last resort. |
| devin | `session/load` JSON-RPC error `-32016` with `data["cognition.ai/errorKind"] === "session_not_found"` | Only after `session/list` confirms the saved cwd; an unlisted id hits the prior `ResumeCwdError` with reason `not_listed`. |
| hermes | ACP error `-32603` with `data.details === "not_found"` (the gateway `session.info` refusal) | The active `HERMES_HOME` gateway and its persisted sessions; the adapter never starts a replacement. |
| kimi (KAP) | HTTP `404` or KAP code `40401` on `GET /sessions/{id}` or `POST /sessions/{id}:resume` | The active Kimi installation/workspace scope. |
| cybion (community) | HTTP `404` on `GET /v1/threads/{id}` | The Cybion account scope for that thread id. |

Hosts should persist the cwd with the session id and reuse it on resume.
Kimi (ACP fallback), OpenCode v1/v2, Antigravity and Devin require a list entry confirming the saved
cwd before resume/load (Kimi KAP reads `GET /sessions/{id}` directly). An unknown or different cwd gives
`ResumeCwdError` (an `UnsupportedOptionError` on `cwd`), which does not mean
missing even when its reason is `not_listed`. Antigravity
CLI 1.5.0 omits unprompted sessions that can still resume; loading an absent
id can even succeed. A listed session's generic native error is not mapped
to missing ([cwd evidence and refusals](../runtimes/resume-cwd.md)). Codex's
`-32600` also covers an archived thread and an active writer
([below](#unavailable-resume-targets)) and the unloaded sub-agent refusal,
which is not mapped. OpenCode v1's generic `-32603` alone is not evidence.
Runtimes not listed above never throw `SessionNotFoundError`.

Evidence: opens without prompts on 2026-10-09, Claude 2.1.292, Codex 0.162.0,
Pi SDK 1.1.0, Grok 1.0.50, Kimi 2.1.1, OpenCode 1.18.30/2.0.26,
Antigravity 1.3.0 and Cursor SDK 1.0.37
([decision](https://github.com/botiverse/oar/issues/294#issuecomment-6090251442)).
Native answers, with ids/temporary paths normalized, are pinned in
[`missing-resume-errors.json`](../../tests/fixtures/missing-resume-errors.json)
and [`claude-missing-resume.json`](../../tests/fixtures/claude-missing-resume.json).
Tests exercise the opening paths, full pagination, redaction and the
must-not-match refusals.

Pi Durable 1.5.2 is additionally covered by the real in-memory Harness tests
in `tests/pi-durable/options.test.ts`, including a storage-failure control.

## Unavailable resume targets

`session({ resume })` rejects with the exported `SessionUnavailableError`
when the runtime keeps the conversation but will not open it now. It has
`name: "SessionUnavailableError"`, `sessionId`, `reason` and
`cause: { method, native }`, with the runtime's words as its message, under
the same redaction rules. Like `SessionNotFoundError` it is not a
`FailureClass`.

| reason | meaning | what a host can do |
|---|---|---|
| `archived` | The user archived the conversation in the runtime's own app. | Decide whether to unarchive it. OAR never does: that reverses the user's own action and puts the conversation back where the user removed it from. |
| `in_use` | Another process, such as the user's app, holds the conversation. | Retry once that process lets it go. It is not a missing conversation. |

| Runtime | Evidence required |
|---|---|
| codex | `thread/resume` JSON-RPC error `-32600` with message `session <id> is archived. …` (`archived`) or `thread <id> already has an active writer` (`in_use`); exact prose is the last resort |
| kimi (KAP) | `GET /sessions/{id}` returns `archived: true` (`archived`), or `POST /sessions/{id}:resume` answers HTTP `409` or KAP code `40901` / `40931` (`in_use`) |

Runtimes not listed above do not map native errors to
`SessionUnavailableError`. The internal [ACP shared factory](acp-shared-connection.md)
also rejects a native id controlled by another lease with `in_use`; its
cause method is `oar/open` and its native data contains only the observed
session id. That is an OAR ownership observation, not a native error; no
native runtime is admitted to shared placement in the current release
([admission status](acp-shared-connection.md#admission-status)). Native evidence:
[`experiments/codex-session-name.ts`](../../experiments/codex-session-name.ts)
(codex 0.162.0, a second app-server standing in for the user's app) and
[`codex-session-name.vendor.test.ts`](../../sea-trial/vendor/codex-session-name.vendor.test.ts).

## Failure evidence

What OAR classifies a failed turn or failed open into (`FailureClass`,
[#227](https://github.com/botiverse/oar/issues/227)), how failure evidence is
collected, which causes each runtime can report, and where each runtime's
classifier and per-cause observations live.

**How.** [`experiments/failure-evidence.ts`](../../experiments/failure-evidence.ts)
opens a session on the real runtime and prompts once, with the model provider
replaced by a scripted one (`aimock`, [harness](../../sea-trial/harness/aimock.ts))
that answers every model request with the error the provider documents for the
cause ([provider replies](#the-provider-replies)). A missing login is a fresh
home with no credential instead. No real account is used and nothing is spent.
Runs: claude 2.1.292, codex 0.160.1, pi SDK 1.0.4, opencode 1.18.30, kimi
2.1.1, grok 1.0.46, antigravity ACP server 1.3.0 (2026-10-08); cursor
(`@cursor/sdk` 1.0.36) against Cursor's own service, with no key or a made-up
one only. No open failed on a model request: open failures came from pre-turn
checks (login, unknown model, Cursor key check); pi rejects the prompt when it
has no key; every other failure came with the turn.

**Evidence rule.** Every failure mapping must be backed either by a live or
recorded run (`[env]`, `[rec]`) or by an explicit named native constant and
meaning from the runtime's own source, generated schema or binary (`[src]`,
`[schema]`, `[sym]`), annotated inline with its native version and location.
Mappings are never invented from guesswork, and a later live observation
(`[env]`/`[rec]`) that disagrees with a source/schema/symbol mapping wins.
Tags: `[env]` observed in a scripted-provider or isolated-home run; `[rec]` a
sanitized recorded run; `[src]` vendor source or type declarations; `[schema]`
generated native protocol schema; `[sym]` binary symbols; `[doc]` vendor
documentation.

### The mapping

**Precedence order.** Each adapter reads, most structured first
([`shared/failure-class.ts`](../../packages/oar/src/shared/failure-class.ts)):

1. The runtime's own error category or stop reason (for example Claude's
   `stop_reason: "refusal"` / `assistant.error` / `terminal_reason`, Codex's
   `codexErrorInfo`, DSH's `LlmFailure.code`, Factory's
   `agent_turn_completed.reason`, CodeBuddy's error category, OpenCode's
   `data.errorName`, Grok's `-32003` / `retry_state.error_type`, ACP's
   `-32000`).
2. The provider's JSON error body when the runtime preserves it (`error.code`,
   else `error.type`; an OpenAI 429 carrying a quota or balance code maps to
   `quota` or `billing` before falling back to `rate_limited`).
3. The HTTP status code when the runtime reports one:

| HTTP status | `FailureClass` |
|---|---|
| `400` | `invalid_request` |
| `401` | `auth` |
| `402` | `billing` |
| `404` | `model_unavailable` |
| `429` | `rate_limited` |
| `503`, `529` | `overloaded` |
| other `5xx` | `provider` |

4. Documented prose matching (`classifyFailure` or `anthropicLimitText`) only
   as a last resort for runtimes whose transport drops structure. Anything none
   of these establishes stays `unknown`.

**Special classes.**
- `model_refused`: the model declined to answer (`stop_reason: "refusal"` on
  Claude, bare ACP `stopReason: "refusal"`). Where a runtime reuses `refusal`
  for non-model errors (CodeBuddy with `_meta["codebuddy.ai/errorMessage"]` or
  `FAILED*` outcome), its native category/status or `unknown` takes precedence.
- `limit_reached` and `output_schema`: host-configured turn/budget limits
  (`error_max_turns`, `error_max_budget_usd`, `max-tokens`) and structured
  output failures (`error_max_structured_output_retries`,
  `structuredOutputError`, `structured_output_*`). `failureAdvice(failure)`
  advises not to retry either until the host changes the limit or schema.

**`FailedTurn` fields.** Every failed turn carries `failure` and `reason`.
Optional fields appear only when the runtime explicitly reports them:
- `status`: the HTTP status code reported for the failure (any class).
- `credential` (`"missing"` or `"rejected"`): only on `auth` when the runtime
  makes the distinction plain.
- `resetsAt` and `rateLimitType`: only on `quota` (see
  [When a limit resets](#when-a-limit-resets)).

**Failed opens (`RuntimeFailureError`).** An open rejects with
`RuntimeFailureError` (`failure`, `reason`, optional `credential`, `status`,
and stable `code` such as `project_packages_blocked`, `runtime_outdated`,
`runtime_config_invalid`) when the adapter has a structured auth, model or
policy refusal at open (`shared/acp/failure.ts`, `cursor/failure.ts`,
`codex/refusal.ts`, `pi/`). Other open errors keep their own error types.
`failureAdvice(failure)` turns any `FailureClass` into a retry policy.

**Per-runtime classifiers and failure observations:**

- Shared helpers: [`shared/failure-class.ts`](../../packages/oar/src/shared/failure-class.ts), [`shared/acp/failure.ts`](../../packages/oar/src/shared/acp/failure.ts), [`shared/acp/projection.ts`](../../packages/oar/src/shared/acp/projection.ts)
- Antigravity: [`runtimes/antigravity/quota.ts`](../../packages/oar/src/runtimes/antigravity/quota.ts), [observations](../runtimes/antigravity.md#failures)
- Claude: [`runtimes/claude/failure.ts`](../../packages/oar/src/runtimes/claude/failure.ts), [`runtimes/claude/projection.ts`](../../packages/oar/src/runtimes/claude/projection.ts), [observations](../runtimes/claude.md#failures)
- CodeBuddy: [`runtimes/codebuddy/failure.ts`](../../packages/oar/src/runtimes/codebuddy/failure.ts), [observations](../runtimes/codebuddy.md)
- Codex: [`runtimes/codex/failure.ts`](../../packages/oar/src/runtimes/codex/failure.ts), [`runtimes/codex/refusal.ts`](../../packages/oar/src/runtimes/codex/refusal.ts), [observations](../runtimes/codex.md#failures)
- Cursor: [`runtimes/cursor/failure.ts`](../../packages/oar/src/runtimes/cursor/failure.ts), [`runtimes/cursor/projection.ts`](../../packages/oar/src/runtimes/cursor/projection.ts), [observations](../runtimes/cursor.md#failures)
- Devin: [`runtimes/devin/session.ts`](../../packages/oar/src/runtimes/devin/session.ts), [observations](../runtimes/devin.md#failures)
- DSH: [`runtimes/dsh/projection.ts`](../../packages/oar/src/runtimes/dsh/projection.ts), [observations](../runtimes/dsh.md#records)
- Factory: [`runtimes/factory/projection.ts`](../../packages/oar/src/runtimes/factory/projection.ts), [observations](../runtimes/factory.md#failures)
- Grok: [`runtimes/grok/failure.ts`](../../packages/oar/src/runtimes/grok/failure.ts), [observations](../runtimes/grok.md#failures)
- Hermes: shared ACP failure mapping, [observations](../runtimes/hermes.md#failures)
- Kimi: KAP ([`runtimes/kimi/kap-failures.ts`](../../packages/oar/src/runtimes/kimi/kap-failures.ts), [`runtimes/kimi/kap-errors.ts`](../../packages/oar/src/runtimes/kimi/kap-errors.ts)) and shared ACP (`shared/acp/failure.ts`), [observations](../runtimes/kimi.md#failures)
- OpenCode: [`runtimes/opencode/failure.ts`](../../packages/oar/src/runtimes/opencode/failure.ts), [observations](../runtimes/opencode.md#failures)
- Pi / Pi Durable: [`runtimes/pi/failure.ts`](../../packages/oar/src/runtimes/pi/failure.ts), [`runtimes/pi-durable/projection.ts`](../../packages/oar/src/runtimes/pi-durable/projection.ts), [observations](../runtimes/pi.md#failures)
- Qoder: [`runtimes/qoder/projection.ts`](../../packages/oar/src/runtimes/qoder/projection.ts), [observations](../runtimes/qoder.md#usage-and-failures)
- Qwen: [`runtimes/qwen/projection.ts`](../../packages/oar/src/runtimes/qwen/projection.ts), [observations](../runtimes/qwen.md#usage-and-failures)
- Tests: [`tests/failure-mapping.test.ts`](../../tests/failure-mapping.test.ts), [`failure-classes.vendor.test.ts`](../../sea-trial/vendor/failure-classes.vendor.test.ts), [`failure-classes-acp.vendor.test.ts`](../../sea-trial/vendor/failure-classes-acp.vendor.test.ts)

### The provider replies

Status and error `type` / `code` sent by the scripted provider (`[doc]`:
[Anthropic](https://platform.claude.com/docs/en/api/errors),
[OpenAI](https://developers.openai.com/api/docs/guides/error-codes), Gemini
generateContent in Google's error shape, [AIP-193](https://google.aip.dev/193)).
The scripted Gemini replies carry no `details` (`ErrorInfo.reason`), which a
real one does.

| cause | Anthropic Messages: claude, pi, opencode | OpenAI: codex (Responses), kimi and grok (chat completions) | Gemini: antigravity |
|---|---|---|---|
| invalid key | 401 `authentication_error` | 401 `invalid_api_key` | 400 `INVALID_ARGUMENT` "API key not valid" |
| unknown or unentitled model | 404 `not_found_error` | 404 `model_not_found` | 404 `NOT_FOUND` |
| rate limited | 429 `rate_limit_error` | 429 `rate_limit_exceeded` | 429 `RESOURCE_EXHAUSTED` |
| usage limit | 400 `invalid_request_error` "You have reached your specified API usage limits" (organization spend limit) | 429 `organization_usage_limit_exceeded`; ChatGPT plan 429 `usage_limit_reached` (codex `[src]`) | 429 `RESOURCE_EXHAUSTED` "You exceeded your current quota" |
| billing | 400 `invalid_request_error` "Your credit balance is too low" (claude tests for this text `[sym]`); 402 `billing_error` | 429 `credit_balance_exhausted`; older 429 `insufficient_quota` | 400 `FAILED_PRECONDITION` "enable billing" |
| server error | 500 `api_error` | 500 `server_error` | 500 `INTERNAL` |
| overloaded | 529 `overloaded_error` | 503 `server_is_overloaded` | 503 `UNAVAILABLE` |
| oversized context | 400 `invalid_request_error` "prompt is too long: 250000 tokens > 200000 maximum" | 400 `context_length_exceeded` | 400 `INVALID_ARGUMENT` "The input token count ... exceeds the maximum" |
| inside a 200 stream | an `error` event (`overloaded_error`, `api_error`) | `response.failed` with `error.code` (Responses API only) | not tried |

The overflow texts are the ones `pi-ai`'s `isContextOverflow` documents per
provider (`[src]`). Not simulated: a Claude subscription usage limit (a 429
carrying `anthropic-ratelimit-unified-*` headers) and a tier's monthly spend
cap (a 429 without `retry-after`).

### Where a class can come from

| cause | claude | codex | pi | opencode | kimi (ACP) | kimi (KAP) | grok | antigravity | cursor |
|---|---|---|---|---|---|---|---|---|---|
| missing login | `error` + null status | info 401 | prompt refusal | text | open -32000 | open `auth.models_ready` | open -32000 | open -32000 | text |
| invalid key | `error` + 401 | info 401 | status in text | text | prompt -32000 | `provider.auth_error` / 401 | `error_type: auth` | nothing | open 401 |
| unknown model | `error` + 404 | info | open (oar) | open -32602 | open -32603 | open (`ModelConfirmationError`) / `model.not_configured` / 404 | open -32602 | open -32602 | not observed |
| rate limited | `error` + 429 | info 429 | status in text | text / `provider.rate-limit` | nothing | `provider.rate_limit` / 429 | -32003 | nothing | not observed |
| usage limit | 400 spend limit; weekly `usage_limit_reached` `[rec]` | info | status in text | text / `data.errorName` | nothing | nothing | -32003 + error type or `subscription:free-usage-exhausted` | individual-quota notice `[rec]` (API-key 429: nothing) | not observed |
| billing | `error` (400 text) or 402 | info | status in text | text | nothing | status 402 | -32003 + error type; 402: -32603 `data.http_status` | nothing | not observed |
| server error | `error` + 500 | info | status in text | text | nothing | `provider.connection_error` / `provider.api_error` / 5xx | `error_type: api` | text | not observed |
| overloaded | 529 | info | status in text | text | nothing | `provider.overloaded` / 503 / 529 | `error_type: api` | nothing | not observed |
| oversized context | `terminal_reason` | info (in stream) | `isContextOverflow` | nothing | nothing | `context.overflow` | `error_type: context_length` | nothing | not observed |

"info" is `codexErrorInfo`; "text" is a message that only prose matching can
read; "nothing" means the turn looks completed or never ends.

### When a limit resets

A `quota` failure carries `resetsAt` (a `UtcInstant`) only when the runtime
reports, for that failure, when the refusing limit resets: never derived from
an account-usage read, an earlier-turn usage snapshot or a retry delay. The
runtime's report may predate the failure; an already-past or unparseable time
leaves `resetsAt` absent, and the host decides whether to continue when the
limit resets. Current implementations live in
[`claude/failure.ts`](../../packages/oar/src/runtimes/claude/failure.ts)
(`usage_limit_reached` inline `rate_limit_info` and rejected
`rate_limit_event`),
[`codex/failure.ts`](../../packages/oar/src/runtimes/codex/failure.ts) (quota
body `resets_at` and current-turn exhausted window), and
[`antigravity/quota.ts`](../../packages/oar/src/runtimes/antigravity/quota.ts)
(native individual-quota countdown notice).

## Adapter red lines

"The adapter drops attribution" appears in identical form in mutually
independent codebases, and upstream has confirmed it. When the protocol
lacks the attribution dimension, this is the adapter's *inevitable*
degeneration path, not an accidental oversight. A session-id entry filter
(`if (params.sessionId !== opened.sessionId) return;`) is its canonical
shape: it throws away every child session's data and makes a nested
runtime artificially opaque.

- kimi-cli: its own ACP adapter has two `case SubagentEvent(): pass` arms
  (live + replay): opacity at the ACP boundary is the adapter's choice, not
  missing data. [src: acp/session.py:203,292]
- kimi-code: the older TS `acp-adapter` package hardcodes
  `if (!isFromMainAgent(event)) return` at each event-class entry; upstream
  issue #2482 names this guard as dropping all non-main-agent events, and
  the fix PR #2484 was closed unmerged.
  [src: acp-adapter/src/session.ts:1024-1100]
  The current source (reviewed 2026-09-08) has `packages/acp-server` bind
  `klient.session(sessionId).agent('main')` and subscribe there, so
  main-only visibility remains. See the
  [current Kimi API page](../runtimes/kimi.md).

**Red line (attribution):** an adapter may degrade to opaque only when the
runtime truly lacks the information, never because the adapter didn't wire
it up. Every adapter must explicitly declare which tier of the spectrum
(#1/#2/#3) it carries, and that declaration must align with what the
runtime actually exposes. The ACP adapter must subscribe to the vendor
lifecycle notifications to discover child sessionIds and receive those
children's standard updates, attributing them per
[attribution.md](attribution.md) and
[session-graph-and-cursor.md](session-graph-and-cursor.md): the
legitimate purpose of a session-id filter (avoiding mis-mixing) is served
by the attribution dimension, not by discarding data.

**Red line (spanId):** `spanId` carries only runtime-native turn/span
identifiers (Codex app-server's `turn.id` / `turnId`, Kimi's turn id, …);
if the runtime provides none, it is honestly absent. oar never generates a
`spanId`; otherwise synthesized turn boundaries would return through this
field.

## Hard spot 1: cross-agent turnId / toolCallId collisions

Each agent generates its own IDs; flattened into one stream they are not
naturally unique (the real difficulty in PR #2484's review). Attribution is
therefore the precondition of ID uniqueness, not a decorative UI field: the
identity of a tool call or turn must be the composite key
`(agentPath, id)`, and a bare `toolCallId` must never be treated as a
global key (Example 4 in [attribution.md](attribution.md)). ACP draft
PR #855's child-session approach solves the same problem another way: a
new session is a new ID namespace. [src]

## Hard spot 2: background children outlive the parent turn

kimi-code has `runInBackground`; kimi-cli's `ApprovalRequest.source_kind`
directly distinguishes `foreground_turn` / `background_agent`. A child's
lifecycle must not hang off the parent turn: a turn ending must not
implicitly close its derived agents, and cursor/completion converge per
agent (`agentPath`); otherwise a background child's tail events are either
lost or misattributed to the next turn. [src: wire/types.py:308-325]

### Example 8 · Background sub-agent: parent turn ends, child stream continues

```
seq=120  ✓ frame  root           result {…}
         ↳ the parent turn's completion event has arrived
seq=121  ✓ frame  path=["bg-7"]  tool_result {…}
seq=122  ✓ frame  path=["bg-7"]  completed {usage:…}
         ↳ the background child is still alive; records keep entering the
           stream, correctly attributed; a settled-gate would swallow
           121 and 122 here
```

## Boundaries and open evidence points

- Not in this protocol: usage *derivation* (cumulative/epoch/boundary
  views), storage ([decision](../design/decisions.md#a-storage-layer-2026-09-03)),
  and query read-models, all consumer business.
- claude's stream-json interleaving under concurrent sub-agents rests on
  [sym]+[doc] evidence; a live `Task` capture would upgrade it and is
  deferred because it costs subscription quota.
- grok's vendor lifecycle notifications rest on [sym] evidence: names
  re-confirmed in the grok 1.0.25 binary, no live check (the probe machine
  has no grok credentials).
- codex child-thread delivery and identity are [env] on codex 0.149.0
  (three runs, experiments/codex-child-threads.ts); the child's
  `turn/completed` can arrive before the root's.

## Interrupted input ownership

`input_dropped` with `turn_interrupted` is emitted by Codex: an interrupted
root turn drops that turn's accepted, un-echoed steers before `turn_ended`.
Factory and DSH emit it for input their runtime reports discarded on abort
([conversation](conversation.md#dropped-input)).
ACP also emits `runtime_refused` when an accepted steer's native RPC later
fails, preserving its error frame without changing the active turn outcome.
Claude, Pi and OpenCode v1 retain the tested interrupted steering input;
Cursor maps `revert_to_followup` to a refused control; SDK 1.4.0
`queued` instead transfers ownership to Cursor, with any cloud follow-up
[unobserved by OAR](../runtimes/cursor.md#prompt-steering-queueing-and-abort). Grok can
lose a just-submitted steer, but its cancellation receipt cannot yet
prove whether that input had been read, so OAR makes no discard claim.
[The audit](../../experiments/input-interruption-2026-10-08.md) records
native versions, evidence and verification limits. Kimi (ACP fallback) has no `steer`
member (Kimi KAP exposes `POST /sessions/{id}/steer`); Antigravity CLI's steer refusal and worker-failure outcomes are on
[its page](../runtimes/antigravity.md#prompt-steering-queueing-and-abort). Independent of runtime, an observed process exit
settles inputs still awaiting echoes as `dropped: runtime_exited`, with the
[resume uncertainty](conversation.md#dropped-input) preserved.

## Qwen SDK channel

[Qwen Code](../runtimes/qwen.md) shares the stream-json fold but has its own
initialization, permission reply, effort confirmation and usage policy
(refusals in [the table above](#refused-session-options)). Its native initialize response
precedes full startup; extension-store failure can surface at the first prompt.
On resume, session usage stays unknown because native cumulative totals include
old turns and there is no trustworthy pre-turn session baseline. Context occupancy
is independent: a supported `get_context_usage` readback after each non-aborted
root result records the native last-prompt count and window before `turn_ended`.
Missing or estimated counts stay unknown; failed queries leave the latest known
reading unchanged ([mapping and cost](../runtimes/qwen.md#current-context)). Errors
without a native typed cause remain unknown. Images are refused before write.
