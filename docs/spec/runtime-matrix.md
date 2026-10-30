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
| qoder | `attributed` | native parent tool ids use the shared stream-json fold; live nested subagent interleavings remain unverified ([mapping](../runtimes/qoder.md)) |
| qwen | `attributed` | stream-json `parent_tool_use_id` maps to agentPath through the shared fold; live nested subagent interleavings remain unverified ([mapping](../runtimes/qwen.md)) |
| claude | `attributed` | frames with `parent_tool_use_id` carry `agentPath = [...parentPath, taskCallId]`, nested through the Task call's own agent; a child's spend is in the session total, `unattributed`: no frame carries its final usage ([env] 2.1.292) |
| codex (app-server) | `nested` | notifications for other thread ids are child-session records (`sessionId` = the thread); a collab item naming the child adds a `tool_call` edge (`subAgentActivity.agentThreadId`). [env] codex 0.149.0: child-thread notifications arrive on the parent's connection (experiments/codex-child-threads.ts) |
| pi-durable | `opaque` | native `watchEvents` covers one conversation; child conversations are not included in that watch |
| pi | `none` | pi has no native sub-agents; `agentPath` is always root |
| cursor (`@cursor/sdk`) | `attributed` | a child's updates arrive inside the parent's `task` call as `tool-call-delta {callId, taskUpdate}` and carry `agentPath = [...parentPath, taskCallId]` ([env] SDK 1.0.35) |
| grok (ACP) | `nested` | `session/update` for other session ids are child-session records; vendor lifecycle notifications add edges when they name a parent ([sym], unverified live; see [open evidence](#boundaries-and-open-evidence-points)) |
| antigravity (ACP) | `opaque` | the `start_subagent` tool call completes at once; the child's tool calls and text then arrive under the parent's session id (the child's own id survives only as the `toolCallId` prefix), so everything lands on root and nothing is fabricated ([env] agy_acp_server 1.2.1) |
| codebuddy (ACP) | `opaque` | standard updates and known vendor notifications are retained; no verified child mapping is inferred ([mapping](../runtimes/codebuddy.md)) |
| kimi (ACP) | `opaque` | `kimi acp` subscribes to the main agent only; the adapter records what arrives and fabricates nothing |
| opencode v1 (ACP) | `opaque` | `opencode acp` forwards only its own sessions' parts; a `task` subagent runs in a child session whose frames never reach the transport, so only the parent's tool call shows ([src] opencode 1.18.34 `acp/event.ts`) |
| opencode v2 (ACP) | `nested` | forwarded child updates carry `_meta["opencode/child-session"]`; OAR uses its `id` and `parentID` for the child session and graph edge, retaining the original envelope in `native` |

| runtime | sub-agent exposure | linkage | per-agent tokens | session graph | resume | evidence |
|---|---|---|---|---|---|---|
| qoder | native parent tool ids on forwarded child frames | `parent_tool_use_id` | root per-query reports summed since open; no inferred child usage | no inferred child-session edges | native UUID in the same HOME/project | [native/current mapping](../runtimes/qoder.md) |
| qwen | native parent tool ids on forwarded child frames | `parent_tool_use_id` | fresh total only; resumed totals unknown without a baseline | no inferred child-session edges | native UUID in the same HOME/project | [native/current mapping](../runtimes/qwen.md) |
| claude | native subagent messages can share the stream | `parent_tool_use_id` | the root's main loop (`result.usage`); subagents and compaction in the session total (`modelUsage`), `unattributed` ([env] 2.1.292) | `agentPath` (not in graph) | native session id | [native/current mapping](../runtimes/claude.md) |
| codex (app-server) | native child threads and collaboration items on the parent's connection | `senderThreadId` / `receiverThreadIds`; `subAgentActivity.agentThreadId` ([env]: `started` on the root names the child, `interacted` on the child names the root) | both threads report their own running total in `thread/tokenUsage/updated`; the child's is in its own session's records, not in the root's `usage().total` ([env]) but in its `withChildren`; the root's counts from when the Session opened ([#169](attribution.md#usage-one-constraint)) | native thread topology; child threads are child sessions | `threadId`; `expectedTurnId` is a steer precondition | [pinned schema/current mapping](../runtimes/codex.md) |
| pi-durable | native child conversations exist, outside the selected watch | no inferred edges | own model/tool ledgers since attachment | no child graph projected | numeric conversation id in host storage | [native/current mapping](../runtimes/pi-durable.md) |
| pi | no native (host composes) | host-nested sessions | flat (host splits) | no runtime-reported edges | session id | [src] |
| cursor (`@cursor/sdk`) | wrapper records (#2) in the parent run's updates | the `task` call id on `tool-call-delta` | each run's `turn-ended` usage is the root's; none seen for a child ([env]) | `agentPath` (not in graph) | `agentId` | [native/current mapping](../runtimes/cursor.md) |
| grok (ACP) | nested sessions (#3), same connection | child has its own ACP sessionId | child ledgers stay native-only: the root's prompt ledger already includes a foreground child's spend, and `withChildren` is absent ([grok](../runtimes/grok.md#context-usage-billing-and-compaction)) | parent→child session edges (in graph, [sym]) | ACP `sessionId` | [native/current mapping](../runtimes/grok.md) |
| antigravity (ACP) | opaque (#1): child activity flattened onto the parent session | `start_subagent` tool card only; child id only as a `toolCallId` prefix | no usage reported for any session ([env]) | nothing fabricated | ACP `sessionId` | [native/current mapping](../runtimes/antigravity.md) |
| codebuddy (ACP) | child identity mapping unverified | nothing inferred | context reports only; token ledger unknown | no inferred child edges | ACP session ID | [mapping](../runtimes/codebuddy.md) |
| kimi (ACP) | opaque (#1): default subscribes main agent only | root `Agent` tool card only | no typed child usage exposed | nothing fabricated from display text | ACP `sessionId` | [native/current mapping](../runtimes/kimi.md) |
| opencode v1 (ACP) | opaque (#1): child sessions not forwarded | root `task` tool card only | no child usage exposed | nothing fabricated | ACP `sessionId` (opencode `ses_` id) | [native/current mapping](../runtimes/opencode.md) |
| opencode v2 (ACP) | child updates forwarded on the parent envelope | native child `id` / `parentID` metadata | children report context only, so there is no token total and no `withChildren` | native parent/child session edges | native ACP session id | [v2 mapping](../runtimes/opencode.md#opencode-v2) |
| kimi-cli (native wire) | wrapper records (#2): `SubagentEvent`, one stream | `parent_tool_call_id` + `agent_id` + `subagent_type` | child events self-attribute | `agentPath`, recursive (not in graph) | session / agent_id | [src] |
| kimi-code (native KAP) | agent graph (#2): key = `(session_id, agent_id)` | `subagentId` + `parentAgentId` + `parentToolCallId` + `runInBackground` | `subagent.completed` carries usage | `agentPath` (not in graph) | session / agent_id | [src] |

## User configuration

`SessionOptions.userConfiguration` is `"include" | "exclude"`. Omission and
`"include"` preserve the adapter's native defaults. In particular, Cursor SDK
already loads no ambient settings by default; `"include"` does not force it
to load layers it normally omits.

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
| Cursor SDK | Explicit empty `local.settingSources` and `local.sandboxOptions.enabled: false`; SDK login and native store remain. Project layers are also absent, as in its default. |
| Codex | Refused: the temporary-home workaround leaves shared history indexes pointing at paths deleted during cleanup. |
| Kimi | Refused: native atomic writes replace the workspace-index symlink and split the workspace catalog. |
| Pi, Pi Durable, Grok, OpenCode v1/v2, Qwen, Antigravity, CodeBuddy | Refused: no verified separation preserving login and history. |

A refusal is `UnsupportedOptionError("userConfiguration", reason)` before
starting a session and is declared in `Runtime.refusedSessionOptions`.
This declaration applies only to `"exclude"`; omission and `"include"` are
accepted. See each [runtime page](../runtimes/README.md) for native evidence.

## Session controls

`prompt`, `queue` and `abort` are on every session. `steer` and `withdraw`
are members a session may lack: a control the runtime cannot do is an
absent member, never a request that is always rejected
([record stream](record-stream.md#the-rules)). Where `queue.durable` is
false, the adapter holds queued input in this process.

| runtime | `steer` | `withdraw` | `capabilities.queue.durable` |
|---|---|---|---|
| qoder | yes: stdin user message with `priority: next`, joining at a tool boundary or following a text-only turn | yes, while held | no |
| qwen | no: native busy writes queue | yes, while held | no |
| claude | yes: a user message written to stdin mid-turn | yes | no |
| codex | yes: `turn/steer` with `expectedTurnId` | no: the queue is codex's own (`thread/queue/add`; [why](record-stream.md#withdrawing-held-input)) | yes |
| pi-durable | yes: native `submit`, `whenBusy: steer` | yes: `submission.abort()` | yes |
| pi | yes: the SDK session's `steer` | yes | no |
| cursor (`@cursor/sdk`) | yes, text only: `run.steer` (images are rejected `unsupported`) | yes | no |
| grok (ACP) | yes: a prompt RPC with `_meta.sendNow` | yes | no |
| codebuddy (ACP) | absent: no verified injection interface | yes | no |
| kimi (ACP) | no | yes | no |
| antigravity (ACP) | no | yes | no |
| opencode v1 (ACP) | yes: a plain prompt RPC mid-turn, which joins the running loop at its next step; both prompts are answered at idle | yes | no |
| opencode v2 (ACP) | absent: concurrent native prompts are refused; `steerOrQueue` and `deliver` use the host queue | yes | no |

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
Observed on Linux on 2026-10-28 with a command that starts a parent and a
child process ([report](../../experiments/runtime-resources-2026-10-28.md)):

| runtime | after `abort` | how the command is stopped |
|---|---|---|
| codex 0.165.0 | keeps running until it exits by itself (about 45 s in the probe), both in an OAR session and in a shared app-server; OAR's 10 s fallback does not apply once codex has ended the turn | `dispose()`. Native `thread/backgroundTerminals/terminate` and `thread/archive` also stop it; OAR does not call them yet |
| grok 1.0.70 (ACP) | keeps running: native cancel and close leave the terminals grok created through the host | `dispose()` releases every terminal OAR hosted for the session |
| kimi 2.3.3, opencode 1.19.5 and 2.2.0, antigravity 1.4.3 (ACP) | stopped within 2 s of the cancel | |
| claude, qwen, qoder, pi (RPC) | not measured | `dispose()`: OAR owns the process |
| pi (in process), cursor | not measured | they run in the host process: `dispose()` ends the SDK session; whether its commands stop is not measured |
| pi-durable | not measured | the host owns the harness: `dispose()` ends observation only |

A host that must know the command is gone ends a session whose process OAR
owns, or waits for the command's own end in the record stream. It never
infers that from the turn end.

## Native goals

`SessionOptions.goals: true` exposes optional `Session.goal` on Codex and
is refused before launch by all other runtimes. Omitted or false preserves
native defaults and exposes no member. Controls and notifications report
`goal_changed` snapshots; ordinary turn completion says nothing about the
goal. Native continuation remains the runtime's responsibility.
[Contract and boundaries](goals.md), [Codex evidence](../runtimes/codex.md#native-goals).

## Context breakdown

`contextBreakdown` is a member a session may lack, like `steer`: only claude
itemizes its context (`get_context_usage`,
[claude.md](../runtimes/claude.md)). codex, pi and the ACP runtimes report a
total and a window at most, which `contextUsage()` folds; a host shows that
where the member is absent.

## Native active turns

`turn_started` is the projection of an OAR prompt request. `turn_active` is
an observation from the runtime and carries no request id. It may name an
`inputId` when the runtime identifies the input it started:

| Runtime | Native activity source |
|---|---|
| qoder | `command_lifecycle started` identifies the input; startup `system/init` alone is idle |
| qwen | root `system/init` for the sole submitted input; no native command_lifecycle acknowledgement |
| claude | `command_lifecycle started` for a prompt-like write identifies its input; a spontaneous root `system/init` has no input id |
| codex | `turn/started`, including queued turns without another OAR prompt |
| pi | `agent_start`, including runs started directly through the SDK |
| pi-durable | Initial active snapshot and `run_start` |

Status becomes running when idle and preserves the current phase when
already running. The session view opens a turn only if none is open, so a
prompt followed by native activity remains one turn. Claude's preceding
`input_queued { inputId }` separates a waiting prompt from an intervening
spontaneous turn; only its matching native start takes that pending input.
This queue fact is reported by Claude and Qoder and excludes steer writes. Child
activity keeps its own attribution and never starts the root turn. Other
adapters do not yet emit `turn_active`.

## Tool outcomes

Native sources for the `tool_call_ended` fields (the rule that they are
never derived is in [record-stream.md](record-stream.md#the-rules)):

| runtime | `content` from | `result` from | `exitCode` from |
|---|---|---|---|
| claude | `tool_result.content` (a string or blocks) | stream-json `tool_result.is_error`, optional and false by default in the Messages API, so an absent field is `ok` ([src]; 2.1.288 omits it on successful Read, Write and Edit) | none (`tool_use_result` carries no exit status) |
| codex | `commandExecution.aggregatedOutput`; an MCP call's result blocks (an error as its message); `webSearch` results as one `other` part; else the item's status word | `item/completed.status` `completed`/`failed` ([src]) | `commandExecution` items' `exitCode` ([src]) |
| pi-durable | native result entry's toolResult content | toolResult `isError`, else a nested call's `result.isError`, only with an actual result | a nested CodingTools call's `result.structuredOutput.exitCode`; a model-issued call carries none in `watchEvents` ([env] Durable 1.2.0 and 1.3.0, [test](../../sea-trial/vendor/pi-durable-exit-code.vendor.test.ts)) |
| pi | `tool_execution_end.result.content` blocks, else the whole result | `tool_execution_end.isError` false/true ([src]) | CodingTools' `result.structuredContent.exit_code` ([env] Pi 1.3.0, [test](../../sea-trial/vendor/pi-exit-code.vendor.test.ts)) |
| grok, kimi, antigravity, opencode (ACP) | the closing `tool_call_update.content` blocks, else `rawOutput`; text parts are cut at 10,000 characters (`native` keeps them whole) | `tool_call_update.status` `completed`/`failed` ([src]) | `rawOutput.exit_code` on the closing `tool_call_update`: grok ([src] grok 1.0.25), antigravity ([env] agy_acp_server 1.2.1) |
| cursor (`@cursor/sdk`) | a shell call's stdout and stderr (one empty text part when it printed nothing), a read's file text, an edit's or write's diff, an error's message, else one `other` part ([env] SDK 1.0.35) | `tool-call-completed` `toolCall.result.status` `success`/`error` ([env] SDK 1.0.35) | a shell call's `result.value.exitCode`, `null` when `signal` names one ([env]) |

A frame without the corresponding native field leaves the key absent; the
native frame stays verbatim beside the event. pi and pi-durable report a
signal as 128 plus its number (SIGTERM is 143), never `null`.

## Service tiers

`SessionOptions.serviceTier` selects a runtime-native tier at open, including
resume. Values come from that model's `ModelEntry.serviceTiers`;
`defaultServiceTier` is present only when the native catalog names a default.
`default` is a separate explicit opt-out, accepted by the supporting runtimes
but never inserted into their tier menus. Omitting the option lets the runtime
choose; it does not promise to clear a configured choice. There is no per-turn
setter: reopen the session to change it.

The adapter reads the applied native value before returning. A refused,
missing or different value fails the open with the requested and actual
selection. OAR does not normalize aliases: codex's `fast` comes back as
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

Claude, codex, grok, kimi, opencode and antigravity apply the overlay to their
runtime process and its tool children; ACP client-hosted terminals receive it
too. OpenCode's prompt preparation queries use the same environment. Pi
applies it to its Bash tool's children, not its in-process provider. Cursor
refuses any non-empty `env`, including a removal-only map. Native tool shells
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
| antigravity | `$GEMINI_HOME` and `SessionOptions.env` | `antigravity-acp/settings.json` with `auth.type = "gemini-api-key"`, then `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL` |
| pi | `models.json` in pi's agent dir (`OAR_PI_AGENT_DIR`) | a `providers.<id>` with `baseUrl`, `apiKey`, `api` and its models; process-wide, since pi runs in-process |
| pi-durable | the host's own `Harness` | `models.setProvider(createProvider({ baseUrl, ... }))` |
| cursor | none | Cursor's SDK talks to Cursor's own backend only |

## Disallowed tools

`SessionOptions.disallowedTools` is a readonly list of native names, sent to
native deny channels on both create and resume. Omitted or empty adds no
restriction; a runtime may restore its own saved settings on resume (notably
Antigravity). OAR neither computes a complementary allowlist nor hides tool
events after execution. This selects tools; another permitted tool can still
perform similar work, so it is not a process sandbox. A model that calls a
denied tool anyway gets the runtime's refusal, not the tool: claude ("No such
tool available"), pi ("Tool … not found"), codex ("unsupported call", with no
tool event) and antigravity (nothing run, no tool event), each pinned by its
vendor test with the omitted-list resume.

| runtime | can disable | refuses |
|---|---|---|
| claude | native `--disallowed-tools` names, including `Bash` and `mcp__server__tool` | unknown or wrong-case names are accepted silently and disable nothing (for example `bash` is not `Bash`); OAR does not validate them |
| pi | SDK `excludeTools`, built-ins such as `bash` and directly exposed MCP names `mcp__server__tool` | native SDK name/pattern semantics apply; unmatched names are accepted silently and disable nothing |
| cursor | SDK `disallowedTools`, including capability groups `shell` (shell plus stdin) and `mcp` (the whole MCP family) | unknown names, including individual MCP names, become `UnsupportedOptionError`; nested native subagents have their own toolset, so deny `task` to prevent spawning them |
| codex | qualified `mcp__server__tool` on an unambiguously named configured or session MCP server, via session `config.mcp_servers.*.disabled_tools`; prior native denies are preserved | built-ins, unqualified names, missing/ambiguous or normalized server namespaces |
| antigravity | canonical `BuiltinTools` filter names via `_meta.antigravity.disabledTools`; see its page for the exact list and native group names | MCP, client file tools, unknown names; a mixed list fails as a whole before launch |
| grok, kimi, opencode | none through the selected OAR transport | every non-empty list, declared in `Runtime.refusedSessionOptions` |

Value-specific refusals identify the offending names. They are not listed
as an always-refused option on codex, cursor or antigravity. The native
channels, observed versions and limits are in the
[October 8 audit](../../experiments/disallowed-tools-2026-10-08.md). Supply
the list again when resuming; OAR does not persist host options.

## Launch arguments

`SessionOptions.launchArgs` adds the host's own command-line arguments to
the runtime process a session starts, for a flag OAR does not model (codex
`-c service_tier="fast"`, claude `--settings`). Outside documented managed
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
| kimi, opencode | after `acp` |
| antigravity | after OAR's own arguments |
| pi, cursor | refused: they run in the host process through their SDKs, with no command line |

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
| grok | `session/prompt._meta.outputSchema` on prompt, held queue drain and send-now steer | Native `_meta.structuredOutput` becomes the completed outcome's value; `_meta.structuredOutputError` fails the turn even when native `stopReason` is `end_turn`. |
| cursor, kimi, opencode (both lines), antigravity, pi, pi-durable | Refused at open; no verified final-output schema channel through these adapters | `UnsupportedOptionError`, declared in `refusedSessionOptions`. |

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
Hosts consuming Codex text
must parse and validate it themselves when their application needs a value
conforming to the schema. Claude retry exhaustion and Grok validation
failures currently retain `failure: "unknown"` with the native reason.

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
| kimi | ACP `session/new.additionalDirectories`, after capability advertisement | A non-empty list is refused before launch: the native resume ignores it. |
| opencode v2 | ACP `additionalDirectories`, after capability advertisement | Pass again; a cold resume without it does not restore the extra roots. |
| opencode v1, grok, antigravity, pi, pi-durable | Refused with `UnsupportedOptionError` | Same refusal. |

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
| cursor, kimi, grok, antigravity, opencode, pi-durable | Refused with `UnsupportedOptionError` | Same refusal. |

Evidence: [`experiments/codex-session-name.ts`](../../experiments/codex-session-name.ts)
(codex 0.162.0) and the vendor tests
[`codex-session-name`](../../sea-trial/vendor/codex-session-name.vendor.test.ts),
[`claude-session-name`](../../sea-trial/vendor/claude-session-name.vendor.test.ts)
and [`pi-session-name`](../../sea-trial/vendor/pi-session-name.vendor.test.ts),
which read the name back through each runtime's own interface.

## Refused session options

What a runtime cannot honor is refused, never dropped: `session()` rejects
with an `UnsupportedOptionError` whose `option` names the refused
`SessionOptions` key and whose message is the reason, rather than open a
session that quietly runs without it. A host may simply try and fall back
on that error, and tells it from a failed login or a network error without
reading the message.

`Runtime.refusedSessionOptions` declares, before any session opens, the
`SessionOptions` a runtime refuses when given (`env`, `mcpServers`, `disallowedTools`, `launchArgs`, `additionalDirectories`: a
non-empty one; `userConfiguration`: `"exclude"`; `goals`: `true`), each with that reason. The adapter checks the same map, so
the declaration and the refusal cannot drift
(`tests/refused-session-options.test.ts`). A host leaves a declared option
out instead of naming runtimes. `outputSchema` is considered given even
when it is an empty object. Another value of an option is declared on its own
because a host can know it in advance: `mcpServerCredentials`, an
`mcpServers` entry carrying a credential (a non-empty `env` on a stdio
entry, non-empty `headers` on an http one). Its error names `mcpServers`
and ends with the entries' names
([#392](https://github.com/botiverse/oar/issues/392)).

Four refusals have one reason wherever the table lists them: `serviceTier`,
no verified per-session tier setting and readback; `outputSchema`, no
verified final-output schema channel; `name`, no verified session name
setting (pi-durable has no session name at all); `additionalDirectories`,
no verified effective additional workspace directory channel. The why
column gives the rest. `userConfiguration: "exclude"` refusals are explained
in [user configuration](#user-configuration).

| runtime | refuses | why |
|---|---|---|
| cursor | `systemPrompt`, `appendSystemPrompt`, `env`, `mcpServers`, `launchArgs`, `serviceTier`, `outputSchema`, `name`, `goals: true` | the SDK's local agent fails a run given a system prompt and has no append; it runs in the host process with no environment or command line of its own; its agent runs on Cursor's servers, and no run without a login or paid tokens shows it calling a tool of `Agent.create`'s `mcpServers` ([cursor](../runtimes/cursor.md#session-mcp-servers)) |
| codebuddy | `appendSystemPrompt`, `serviceTier`, `additionalDirectories`, `outputSchema`, `name`, `userConfiguration: "exclude"`, `goals: true` | no verified private prompt-append input; replacement uses a private file ([mapping](../runtimes/codebuddy.md)) |
| kimi | `systemPrompt`, `appendSystemPrompt`, `disallowedTools`, `serviceTier`, `outputSchema`, `name`, `userConfiguration: "exclude"`, `goals: true` | `kimi acp` has no per-session prompt input; its launcher does not forward the CLI's agent-profile flags, and has no session tool-denial overlay ([audit](../runtimes/kimi.md#models-instructions-and-context)) |
| antigravity | `systemPrompt`, `serviceTier`, `additionalDirectories`, `outputSchema`, `name`, `mcpServerCredentials`, `userConfiguration: "exclude"`, `goals: true` | the selected server has no system prompt replacement input (append is supported) ([audit](../runtimes/antigravity.md#models-instructions-and-context)); it would store an entry's `env` and `headers` values in plain text in its conversation database ([antigravity](../runtimes/antigravity.md#session-mcp-servers)) |
| grok | `disallowedTools`, `serviceTier`, `additionalDirectories`, `name`, `userConfiguration: "exclude"`, `goals: true` | the top-level CLI denylist is not forwarded to `agent stdio`; replacing the selected agent profile is not a tool overlay |
| opencode, both lines | `disallowedTools`, `serviceTier`, `outputSchema`, `name`, `userConfiguration: "exclude"`, `goals: true` | agent permissions can override global denies; permission names do not consistently match tool names |
| pi-durable | `systemPrompt`, `env`, `launchArgs`, `serviceTier`, `mcpServers`, `disallowedTools`, `additionalDirectories`, `outputSchema`, `name`, `userConfiguration: "exclude"`, `goals: true` | native instructions append only; host-owned environment; no process arguments or verified per-conversation tier/MCP/tool-denial mapping |
| pi | `launchArgs`, `serviceTier`, `additionalDirectories`, `outputSchema`, `userConfiguration: "exclude"`, `goals: true` | it runs in the host process through its SDK, with no command line |
| qwen | `serviceTier`, `outputSchema`, `name`, `userConfiguration: "exclude"`, `goals: true` | no verified tier, structured-output, session-name or user-configuration exclusion channel |
| qoder | `serviceTier`, `outputSchema`, `name`, `userConfiguration: "exclude"`, `goals: true` | no verified tier, structured-output, session-name or user-configuration exclusion channel |
| codex | `userConfiguration: "exclude"` | temporary clean homes break shared history paths after cleanup ([evidence](../runtimes/codex.md#user-configuration)) |
| claude | `goals: true` | no structured native goal controls on the chosen transport; other value-specific refusals are described on its runtime page |

`mcpServers` is refused until a runtime's channel is shown to make its agent
call an attached server's tool, with the evidence on its runtime page
([#170](https://github.com/botiverse/oar/issues/170)). Where it is taken:

| runtime | channel | stdio | http | resume | a name the user's config also has |
|---|---|---|---|---|---|
| claude | `--mcp-config <path>`: a 0600 FIFO removed once claude has read it (a 0600 file removed when the process ends on Windows); strict host-only configuration when user configuration is excluded | yes | yes | the flag again | the session's server replaces the user's for that process ([claude](../runtimes/claude.md#session-mcp-servers)) |
| codex | `config.mcp_servers` on `thread/start` and `thread/resume` | yes | yes | the override again | merged into the user's entry field by field; oar's `command` / `url`, `args` and `enabled = true` win ([codex](../runtimes/codex.md#session-mcp-servers)) |
| grok | ACP `mcpServers` on `session/new` and `session/resume`; the model reaches the tools through grok's `use_tool` | yes | yes | the param again | the session's replaces the user's `config.toml` entry; the user's others stay ([grok](../runtimes/grok.md#session-mcp-servers)) |
| codebuddy | ACP `mcpServers` on `session/new` and `session/load` | yes | yes | the param again | conflict precedence unverified; credentialed new/resumed calls and no native HOME persistence verified ([mapping](../runtimes/codebuddy.md)) |
| kimi | ACP `mcpServers` on `session/new` and `session/resume` | yes | yes | the param again | the session's replaces the user's `mcp.json` entry; the user's others stay ([kimi](../runtimes/kimi.md#session-mcp-servers)) |
| opencode | ACP `mcpServers` on `session/new` and `session/resume`, held by that opencode process | yes | yes | the param again | the session's replaces the user's `mcp` entry for that process (a session server that fails to start removes it); the user's others stay ([opencode](../runtimes/opencode.md#session-mcp-servers)) |
| antigravity | ACP `mcpServers` on `session/new` and `session/resume`, started at the first prompt; the model calls them through `call_mcp_tool`. An entry with `env` or `headers` is refused (`mcpServerCredentials`, above) | yes | yes | the param again | the session's replaces the user's `mcp_config.json` entry; the user's others stay ([antigravity](../runtimes/antigravity.md#session-mcp-servers)) |
| pi | pi's MCP extension plus one registering the entries (`pi.registerMcpServer`); tools declared directly | yes | yes | registered again | oar's pi loads no `mcp.json`; a name another extension registered fails the open ([pi](../runtimes/pi.md#session-mcp-servers)) |

Evidence: the vendor tests run the real CLI (pi: the bundled SDK) against a
scripted provider whose model calls a stdio and an http echo server's tool, on
open and on a resume in a new process, and assert the provider received what
only that server writes, carrying the credential the entry gave it:
[`mcp-servers.vendor.test.ts`](../../sea-trial/vendor/mcp-servers.vendor.test.ts)
(claude, codex), [`mcp-servers-pi.vendor.test.ts`](../../sea-trial/vendor/mcp-servers-pi.vendor.test.ts)
and [`mcp-servers-acp.vendor.test.ts`](../../sea-trial/vendor/mcp-servers-acp.vendor.test.ts)
(grok, kimi, opencode, antigravity: each CLI pointed at aimock from a fresh
home, [harness](../../sea-trial/harness/aimock-acp.ts); run locally, as CI
has no ACP aimock backend). The same tests cover the name clash and check that
no record holds a credential. The recordings are
`tests/replay/fixtures/{claude,codex,pi}-mcp-echo.raw.jsonl`.

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

The refusals below depend on a value, the installed version or the session
itself, so `refusedSessionOptions` does not declare them; each is the same
`UnsupportedOptionError`.

| Runtime and condition | Refused option | Migration |
| --- | --- | --- |
| Claude, `resume` supplied | `systemPrompt`, `appendSystemPrompt` | Omit both to keep the saved prompts; create a new session to change them. |
| Codex, `resume` supplied | `appendSystemPrompt` | Omit it to keep saved developer instructions; create a new session to change them. A replacement `systemPrompt` still applies on resume. |
| Pi SDK/RPC, `resume` supplied | No refusal for nonempty prompt options | Pass `systemPrompt` and `appendSystemPrompt` again: the session file does not save them, and omission returns to Pi's default prompt and current project resources. |
| Pi Durable, `resume` supplied | `systemPrompt` (also refused on creation) | Omitted `appendSystemPrompt` retains saved instructions; supplying it replaces them. Changes while adopting an active run are refused. |

The Claude/Codex prompt refusals happen before any process starts, including for empty
strings or the same text a host supplies on every open. Neither native
interface provides the original text for an authoritative comparison.
Claude 2.1.309 ignores both overrides; Codex 0.164.0 ignores the append but
applies replacement ([request evidence](../../experiments/runtime-version-checks/2026-10-23.md#resumed-system-prompts)).
Hosts may catch `UnsupportedOptionError` and reopen with the refused option
omitted; OAR does not remove it silently or invent a replacement session.

OpenCode v1 carries prompt options through native inline configuration. An
already-defined `OPENCODE_CONFIG_CONTENT` refuses either prompt option, and
an empty replacement is refused because native OpenCode selects its built-in
prompt for that value ([evidence](../runtimes/opencode.md#models-effort-instructions-and-context)).
OpenCode v2 refuses both prompt options after checking the installed line
(v1 supports both): there is no verified session-local injection path, and
its instruction loader ignores the v1 `instructions` configuration.

Grok 1.0.52 refuses an append-only prompt change on resume, since native
`rules` is not reapplied without an override, and a blank `systemPrompt` on
creation and resume, even alongside an append, since it treats that as
omitted. `systemPrompt` and `appendSystemPrompt` use separate native
override/rules fields; together they are supported on creation and resume
([request evidence](../runtimes/grok.md#models-and-instructions)).

Kimi and opencode refuse a `resume` that names another directory than
the one their `session/list` says the session lives in (option `cwd`): they
would run the session in its own directory instead, and only the runtime
knows that directory ([resume in another directory](../runtimes/resume-cwd.md)).

An ACP runtime whose session advertises no `thought_level` config option
has no effort channel, so it refuses `effort` once its handshake shows that
(`shared/acp/effort.ts`, `tests/acp/acp-session-effort.test.ts`).
Antigravity 1.4.0 advertises this selector for its grouped model families.
The menu belongs to the model in effect: opencode offers one only for a
model with variants, so after a requested model switch the switch's answer
is read, not the open's ([env] opencode 1.18.30). A level a runtime does not
offer is a plain error naming the level, not this one.

## Host-served tools

Tools the host implements itself reach the agent through `mcpServers` too,
not through a channel of their own. `serveMcpTools({ name, tools })` serves
them from a streamable HTTP MCP server inside the host process, on
`127.0.0.1` behind a random bearer token, and returns the `mcpServers` entry
(`{ name, type: "http", url, headers: { Authorization } }`) and `close()`.
Each runtime then attaches it through its own MCP channel above, so it
behaves as any http entry does there: claude, codex, pi, grok, kimi and
opencode take it; cursor and pi-durable refuse `mcpServers`, and
antigravity refuses an entry with `headers`. A host tells before opening:
served tools attach unless `refusedSessionOptions` declares `mcpServers` or
`mcpServerCredentials`. The runtime must reach the host's loopback address,
which holds for every runtime OAR starts on this machine or runs in this
process.

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
| `full` | pi, opencode (both lines), antigravity | offers the new set: added tools appear, removed ones disappear (antigravity: its system instruction's MCP catalog; opencode 2.x: a system update) |
| `additions` | claude | adds new tools; removed tools' already loaded schemas remain offered, though search withdraws their names and calls fail as unknown tools ([2.1.304 evidence](../../experiments/runtime-version-checks/2026-10-20.md#claude-21304)) |
| `none` | codex, kimi, grok | keeps the opening set; the client never lists again (grok's `use_tool` answers "Tool not found" for an added tool) |

cursor and pi-durable take no `mcpServers` and declare nothing. The
declaration covers any attached MCP server that announces a change, so
antigravity's matters only for credential-free servers: a `serveMcpTools`
entry never attaches there. A change a session does not take applies when
the host opens its next session. Measured [env] 2026-10-14: pi ^1.2.0, opencode 1.18.30, 1.19.0 and 2.0.29,
antigravity 1.4.0, claude 2.1.299, codex 0.162.0 and 0.162.1, kimi 2.1.1,
grok 1.0.52 ([probe](../../experiments/mcp-tools-list-changed.ts),
[vendor test](../../sea-trial/vendor/mcp-tools-list-changed.vendor.test.ts)).

Evidence: [`serve-mcp-tools.vendor.test.ts`](../../sea-trial/vendor/serve-mcp-tools.vendor.test.ts)
runs the real claude, codex and pi (in CI) and opencode, kimi and grok
(locally) against a scripted provider whose model calls a tool the test
process serves; the provider receives the words only the host's handler
writes, and no record holds the bearer token.
[`tests/mcp-serve-tools.test.ts`](../../tests/mcp-serve-tools.test.ts) pins
the protocol, authorization, cancellation, `setTools` and `close()`.

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
| antigravity | `session/resume` or `session/load` JSON-RPC error `-32002` | The active `GEMINI_HOME`; native data names the expected path. |
| grok | Resume/load error `data.code === "FS_NOT_FOUND"` | This cwd, including a real id saved under another cwd. |
| cursor | SDK error `code === "agent_not_found"` from `Agent.listRuns` or `Agent.resume` | Not found by the SDK with this configuration; the 1.0.37 probe had no `CURSOR_API_KEY`, and did not test a real id. |
| pi | OAR's `SessionManager.list(cwd, sessionDir)` lookup has no matching id | This cwd and agent directory, including a real id saved under another cwd. The cause reports the lookup scope and count, not an invented native error. |
| pi-durable | `Harness.conversation(id)` returns `undefined` for a valid native numeric id | The host's Harness and storage. Malformed ids and failed storage queries retain their ordinary errors; no replacement is created. |
| kimi, opencode v1/v2 | A complete `session/list` walk has no matching id, then resume/load returns a native error | The runtime's session list. A listed id's generic error, an unavailable/incomplete list, or a successful resume never means missing. Authentication refusals retain `RuntimeFailureError`. |
| claude | During resume, before the `initialize` answer, `result/error_during_execution` with `errors[0]` starting `No conversation found with session ID` | The active Claude configuration; exact prose is the last resort. |
| codex | `thread/resume` JSON-RPC error `-32600` with message starting `no rollout found for thread id` | The active Codex storage/configuration; exact prose is the last resort. |

Hosts should persist the cwd with the session id and reuse it on resume.
Kimi and OpenCode reject a listed session from another cwd with
`UnsupportedOptionError` on `cwd`, which does not mean missing. Codex's
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

Pi Durable 1.4.0 is additionally covered by the real in-memory Harness tests
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

Runtimes not listed above never throw `SessionUnavailableError`. Evidence:
[`experiments/codex-session-name.ts`](../../experiments/codex-session-name.ts)
(codex 0.162.0, a second app-server standing in for the user's app) and
[`codex-session-name.vendor.test.ts`](../../sea-trial/vendor/codex-session-name.vendor.test.ts).

## Failure evidence

What each runtime reports when a session fails for a common cause, and the
`FailureClass` oar maps it to ([#227](https://github.com/botiverse/oar/issues/227)):
a failed turn's `failure`, `credential` and `status`, or the
`RuntimeFailureError` an open rejects with. The **oar** column of each table
is what oar gives; the [mapping rules](#the-mapping) say why.

**How.** [`experiments/failure-evidence.ts`](../../experiments/failure-evidence.ts)
opens a session on the real runtime and prompts once, with the model provider
replaced by a scripted one (aimock, [harness](../../sea-trial/harness/aimock.ts))
that answers every model request with the error the provider documents for the
cause ([replies](#the-provider-replies)). A missing login is a fresh home with
no credential instead. No real account is used and nothing is spent. Runs:
claude 2.1.292, codex 0.160.1, pi SDK 1.0.4, opencode 1.18.30, kimi 2.1.1,
grok 1.0.46, antigravity ACP server 1.3.0 (2026-10-08); cursor (`@cursor/sdk`
1.0.36) against Cursor's own service, with no key or a made-up one only.

**Evidence level** of each cell: `[env]` observed in such a run; `[rec]` a
recorded run (no failure cell has one yet); `[src]` vendor source or type
declarations, `[sym]` binary symbols; `[doc]` vendor documentation. **Not
observed** means none of these. Only `[env]` and `[rec]` cells may back a
mapping; the others are reference. Every cell below is `[env]` unless tagged.

No open failed on a model request: the opens that failed did so on a check
made before any (a login; a model the runtime, or oar for pi, does not know;
cursor verifies its key with its service). The cells marked **open** hold
those; pi refuses the prompt when it has no key; every other failure came
with the turn.

### The mapping

Each adapter reads, in order: the runtime's own category for the failure
(claude's `assistant.error`, codex's `codexErrorInfo`, grok's
`retry_state.error_type`, ACP's -32000); then the provider's error body that
the runtime passes on (its `code`, else its `type`: pi's `errorMessage`, a
codex `other`); then the HTTP status the runtime reports (401 `auth`, 402
`billing`, 404 `model_unavailable`, 429 `rate_limited`, 503 and 529
`overloaded`, another 5xx `provider`, 400 `invalid_request`). An OpenAI 429
whose code names a quota or a balance (`insufficient_quota`,
`organization_usage_limit_exceeded`, `usage_limit_reached`,
`credit_balance_exhausted`) is `quota` or `billing`; only one without such a
code is `rate_limited`. Matching the words is each adapter's last resort,
named in its table below. What none of these says is `unknown`.

Two classes are the host's own settings, not the provider's: `limit_reached`
(claude's result subtypes `error_max_turns` and `error_max_budget_usd`, from
`--max-turns` and `--max-budget-usd`) and `output_schema` (claude's
`error_max_structured_output_retries` and grok's `structuredOutputError`, under
`SessionOptions.outputSchema`). `failureAdvice` says not to retry either until
the host changes the limit or the schema. A claude error result's `reason` is
its subtype followed by claude's own `errors` text when it gives any
(`error_max_turns: Reached maximum number of turns (2)`).

Only `[env]` cells are mapped. A value a runtime declares that no run
produced stays unmapped (it falls through to the status or to `unknown`)
until it is observed: claude's `oauth_org_not_allowed`, `account_on_hold`,
`verification_required`, `overloaded`, `max_output_tokens`,
`cloud_credential_error`; codex's `unauthorized`, `badRequest`,
`sessionBudgetExceeded`, `cyberPolicy` and the rest of its schema; Anthropic's
`request_too_large` and `permission_error`; OpenAI's spend-limit and
`slow_down` codes. One mapping rests on `[src]` and `[sym]` alone: claude's
`rate_limit` after a `rejected` `rate_limit_event` naming a reset is `quota`
([below](#when-a-limit-resets)). Only a subscription at its limit makes
claude send that event, and oar never triggers an error on a real account.

A failed turn (`FailedTurn`) is tagged by `failure`: `credential` exists
only on `auth`, `resetsAt` only on `quota`, `status` on every class. A host
checks `failure` before reading either. `resetsAt` is set only where the
runtime reports, for the failure, when the limit that refused it resets
([below](#when-a-limit-resets)).

`credential` is set only where the runtime makes it plain: claude's
`authentication_failed` with no request sent (`missing`) or a 401
(`rejected`), and cursor's `AuthenticationError` at open (`rejected`).
ACP's -32000, a codex 401 and a pi 401 do not say which. `status` is the
HTTP status where the runtime reports one.

Known blur, kept because the runtime does not tell the causes apart: codex's
`usageLimitExceeded` covers a usage limit and an exhausted balance alike
(`quota`); claude's 429 without a `rejected` `rate_limit_event` covers a
tier's monthly spend cap as well as throttling (`rate_limited`); grok's -32003 covers every 429 (`rate_limited`).
kimi and antigravity report most failed turns as completed, so oar does too.

An open fails with a `RuntimeFailureError` (`failure`, `credential`,
`status`, `reason`) for: ACP's -32000 on `initialize`, `authenticate`,
`session/new` or `session/resume` (`auth`); an invalid-params answer (-32602)
to the call that selects the model (`model_unavailable`); cursor's
`AuthenticationError` (`auth`, `rejected`); a pi model oar does not find in
pi's registry (`model_unavailable`). Pi's project-installation policy refusal
uses `failure: "invalid_request"` and the stable OAR code
`project_packages_blocked`; it never means the resumed session or cwd is
missing. Its reason explains how to enable native offline mode or explicitly
allow installation. Other open failures keep their errors
(kimi's unknown model is a -32603 that only its words explain).
`failureAdvice(failure)` (observe) turns any class into one retry policy.

Each mapped cell has a vendor test: [`failure-classes.vendor.test.ts`](../../sea-trial/vendor/failure-classes.vendor.test.ts)
(claude, codex, pi, in CI) and [`failure-classes-acp.vendor.test.ts`](../../sea-trial/vendor/failure-classes-acp.vendor.test.ts)
(the ACP runtimes, run locally like the other ACP vendor tests), which also
pin kimi's and antigravity's completed-looking failures and opencode's
classes by its words. The adapters' mappings are unit-tested on the observed
facts ([test](../../tests/failure-mapping.test.ts)).

### The provider replies

Status and error `type` / `code` as the scripted provider sent them. The
statuses, types and codes are the providers' documented ones `[doc]`
([Anthropic](https://platform.claude.com/docs/en/api/errors),
[OpenAI](https://developers.openai.com/api/docs/guides/error-codes),
Gemini's generateContent in Google's error shape, [AIP-193](https://google.aip.dev/193));
a message the docs do not give is illustrative. The scripted Gemini replies
carry no `details` (Google's `ErrorInfo.reason`), which a real one does.

| cause | Anthropic Messages: claude, pi, opencode | OpenAI: codex (Responses), kimi and grok (chat completions) | Gemini: antigravity |
|---|---|---|---|
| invalid key | 401 `authentication_error` | 401 `invalid_api_key` | 400 `INVALID_ARGUMENT` "API key not valid" |
| unknown or unentitled model | 404 `not_found_error` | 404 `model_not_found` | 404 `NOT_FOUND` |
| rate limited | 429 `rate_limit_error` | 429 `rate_limit_exceeded` | 429 `RESOURCE_EXHAUSTED` |
| usage limit | 400 `invalid_request_error` "You have reached your specified API usage limits" (a spend limit the organization set) | 429 `organization_usage_limit_exceeded`; a ChatGPT plan's 429 `usage_limit_reached` (codex `[src]`) | 429 `RESOURCE_EXHAUSTED` "You exceeded your current quota" |
| billing | 400 `invalid_request_error` "Your credit balance is too low" (claude tests for this text `[sym]`); 402 `billing_error` | 429 `credit_balance_exhausted`; the older 429 `insufficient_quota` | 400 `FAILED_PRECONDITION` "enable billing" |
| server error | 500 `api_error` | 500 `server_error` | 500 `INTERNAL` |
| overloaded | 529 `overloaded_error` | 503 `server_is_overloaded` | 503 `UNAVAILABLE` |
| oversized context | 400 `invalid_request_error` "prompt is too long: 250000 tokens > 200000 maximum" | 400 `context_length_exceeded` | 400 `INVALID_ARGUMENT` "The input token count … exceeds the maximum" |
| inside a 200 stream | an `error` event (`overloaded_error`, `api_error`) | `response.failed` with `error.code` (Responses API only) | not tried |

The overflow texts are the ones pi-ai's `isContextOverflow` documents per
provider `[src]`. Not simulated: a Claude subscription's usage limit (a 429
whose `anthropic-ratelimit-unified-*` headers the scripted provider cannot
send) and a tier's monthly spend cap (a 429 without `retry-after`).

### claude

Every cause ends the turn with an `assistant` frame whose top-level `error`
names a category (its text is the message), then a `result` with
`is_error: true`, `api_error_status` (the HTTP status; `null` when no request
was sent) and `terminal_reason`. A retried cause first sends `system/api_retry`
frames `{attempt, max_retries, retry_delay_ms, error_status, error}`: 10 retries
by default (`CLAUDE_CODE_MAX_RETRIES`; the runs set 1).

| cause | `assistant.error` | `api_error_status` | retried (`api_retry.error`) | oar |
|---|---|---|---|---|
| missing login | `authentication_failed` ("Not logged in · Please run /login") | `null` | no | `auth`, `missing` |
| invalid key | `authentication_failed` | 401 | yes (`authentication_failed`) | `auth`, `rejected` |
| unknown model | `model_not_found` | 404 | no | `model_unavailable` |
| rate limited | `rate_limit` | 429 | yes (`rate_limit`) | `rate_limited` |
| usage limit (400) | `unknown` | 400 | no | `quota`: the words ("specified API usage limits"), the last resort |
| billing: credit balance (400) | `billing_error` ("Credit balance is too low") | 400 | no | `billing` |
| billing: 402 | `unknown` | 402 | no | `billing` (the status) |
| server error | `server_error` | 500 | yes (`server_error`) | `provider` (the status) |
| overloaded | `server_error` | 529 | yes (`overloaded`) | `overloaded` (the status) |
| oversized context | `invalid_request`; `terminal_reason: prompt_too_long` | 400 | no | `input_too_large` |
| inside the stream | none: claude retries the stream, then repeats the request without streaming, and that answer ends the turn | | | |

After a tool call the fields are the same; an oversized context first tries
compaction (`system/status` `compacting`). Other `error` values claude 2.1.292
declares: `oauth_org_not_allowed`, `account_on_hold`, `verification_required`,
`overloaded`, `max_output_tokens`, `cloud_credential_error` `[sym]`; a
subscription's limits arrive as `rate_limit_event` frames `[sym]`, not observed
(a `rate_limit` after a rejection naming a reset is `quota` with `resetsAt`,
[below](#when-a-limit-resets)).

### codex

The turn ends with `turn/completed` (`status: failed`) whose `turn.error` is
`{message, codexErrorInfo, additionalDetails, misalignment}`, after an `error` notification
with `willRetry: false`. Each retry is an `error` notification with
`willRetry: true`, `codexErrorInfo: {responseStreamDisconnected: {httpStatusCode}}`
and the message "Reconnecting... n/5".

| cause | `codexErrorInfo` | retried | oar |
|---|---|---|---|
| missing login (no key, the default provider: codex sent the request to api.openai.com, which answered 401) | `{httpConnectionFailed: {httpStatusCode: 401}}` | over WebSocket, then (a `warning` "Falling back from WebSockets to HTTPS transport") 5 over HTTPS: 9 notifications | `auth` (the status) |
| invalid key | `{httpConnectionFailed: {httpStatusCode: 401}}` | 5 | `auth` (the status) |
| unknown model | `modelNotFound` on 0.165.0; formerly `{httpConnectionFailed: {httpStatusCode: 404}}` | 1 on 0.165.0 | `model_unavailable`; status only when native reports it |
| rate limited | `{responseTooManyFailedAttempts: {httpStatusCode: 429}}` | no notification | `rate_limited` (the status) |
| usage limit, plan usage limit | `usageLimitExceeded` ("Quota exceeded. Check your plan and billing details."; "You've hit your usage limit.") | no | `quota` |
| billing (both codes) | `usageLimitExceeded` ("Quota exceeded…") | no | `quota` |
| server error | `internalServerError` | 5 (`httpStatusCode: null`) | `provider` |
| overloaded | `serverOverloaded` | no | `overloaded` |
| oversized context (an HTTP 400) | `other` (the message is the provider's JSON) | no | `input_too_large` (the body's `code`) |
| in the stream: `context_length_exceeded` | `contextWindowExceeded` | no | `input_too_large` |
| in the stream: `server_is_overloaded` | `serverOverloaded` | no | `overloaded` |
| in the stream: `insufficient_quota`, `usage_not_included` | `usageLimitExceeded` | no | `quota` |
| in the stream: `rate_limit_exceeded` | `rateLimitExceeded` | 5 | `rate_limited` |

A 401 is `httpConnectionFailed`, not the declared `unauthorized`; the schema
also declares `sessionBudgetExceeded`, `badRequest`, `cyberPolicy` and others
`[src]` (`codex app-server generate-json-schema`). After a tool call the
values are the same.

### pi

| cause | where | what it carries | oar |
|---|---|---|---|
| missing key | the prompt is rejected (`runtime_refused`), no turn | "No API key found for the selected model." | (no turn) |
| unknown model | the open fails (oar's own check against pi's registry) | `RuntimeFailureError` | `model_unavailable` |
| every provider error | the assistant message: `stopReason: "error"`, `errorMessage` | "<status> <the provider's JSON body>"; inside a stream the body alone, no status | pi-ai's `isContextOverflow` first (`input_too_large`), then the body's `type` / `code` (Anthropic's 400 spend-limit and credit-balance wording as the last resort), then the status; `status` from the prefix |

Rate limits, server errors and overload (also inside a stream) are retried
three times, each announced by `auto_retry_start {attempt, maxAttempts, delayMs,
errorMessage}`, ended by `auto_retry_end`; `agent_end.willRetry` says whether
another attempt follows. pi-ai keeps the status apart
(`normalizeProviderError`) but puts only the text on the message, and exports
`isContextOverflow(message)` for the overflow texts `[src]`.

### opencode, kimi, grok, antigravity (ACP)

| cause | opencode | kimi | grok | antigravity |
|---|---|---|---|---|
| missing login | no local check: the request goes without a key; the provider's 401 ("x-api-key header is required") comes back as prompt: -32603 "Internal error: x-api-key header is required". With no provider configured at all, opencode answered from its own hosted model: no failure | open: -32000 "Authentication required" | open: -32000 "Authentication required", `data` "no auth method id provided" | open: -32000 "Authentication required", `data.message` "No authentication method selected…" |
| invalid key | prompt: -32603 "Internal error: invalid x-api-key", `data {service: "session", errorName: "APIError"}` | prompt: -32000 "Authentication required: 401 …" | `retry_state {type: failed, error_type: auth}`, `turn_completed.stop_reason: error`, prompt: -32603 "Internal error", `data` the provider text | turn completes (`end_turn`), no message |
| unknown model | open: -32602 "Invalid params: model not found", `data {providerId, modelId}` | open: -32603 "Internal error", `data.details` "Model … is not configured" | open: -32602 "Invalid params", `data` "unknown model id" | open: -32602 "Model … is not available for the current authentication method", `data {modelId, availableModels}` |
| unentitled model (provider 404) | prompt: -32603 "Internal error: model: …" | turn completes, no message | `retry_state {failed, api}`, prompt: -32603 | turn completes; the provider text as agent text |
| rate limited, usage limit (OpenAI and Gemini: a 429; Anthropic's usage limit: a 400) | prompt: -32603 "Internal error: <provider message>" | turn completes, no message | `retry_state {retrying, rate_limited}` then `{exhausted, is_rate_limited: true}`, `stop_reason: rate_limit`, prompt: -32003 "Rate limited", `data` "API error (status 429 …): …" | no frame within 150 s |
| billing (OpenAI: a 429; Anthropic: a 400 or 402; Gemini: a 400) | prompt: -32603 "Internal error: …" | turn completes, no message | as for the 429s above: -32003 "Rate limited" | turn completes, no message |
| server error, overloaded | prompt: -32603 "Internal error: …", after about 70 s of silent retries | turn completes, no message, after about 140 s | `retry_state {retrying, api}` up to `max_retries: 15`: no turn end within 150 s | 500: the provider text as agent text, then `end_turn`; 503: no frame within 150 s |
| oversized context | no turn end within 150 s | compaction messages ("Compaction cancelled."), then `end_turn` | `retry_state {failed, context_length}`, prompt: -32603 | turn completes, no message |
| oar | its words, the last resort (`auth`, `rate_limited`, `quota`, `billing`, `overloaded`, `provider`); an unknown model: `RuntimeFailureError` `model_unavailable` | open and prompt -32000: `auth` (at open a `RuntimeFailureError`); else a completed turn | open: `RuntimeFailureError` `auth` or `model_unavailable`; -32003 `rate_limited`; -32603 by the final `retry_state.error_type` (`auth`, `input_too_large`, `provider`) | open: `RuntimeFailureError` `auth` or `model_unavailable`; else a completed turn, or none (429, 503) |

**Known: kimi and antigravity report a failed turn as completed.** kimi
records the failure in its own session (`wire.jsonl`: `turn.ended`
`reason: failed`, `error {code: "provider.rate_limit", name, details.statusCode,
retryable}`, and `turn.step.retrying`), but answers the ACP prompt `end_turn`
with no message, so oar records `completed`. That file is kimi's private
storage, not an interface, and oar reads only the ACP stream. antigravity
likewise ends most failed turns `end_turn`, some with the provider's text as
agent text. Not tried on the ACP runtimes: errors inside a stream, and after
a tool call.

### cursor

| cause | what it reports | evidence |
|---|---|---|
| missing login (no stored key, no `CURSOR_API_KEY`) | the open succeeds; the run ends `status: error`, `error.message` "[unknown] Invalid User API Key", no code. oar: `auth` from the words, the last resort | `[env]` |
| invalid key (a made-up `CURSOR_API_KEY`) | the open rejects with `AuthenticationError {status: 401, code: "error"}`. oar: `RuntimeFailureError` `auth`, `rejected`, 401 | `[env]` |
| the other causes | not observed: each needs an account. The SDK's errors are `AuthenticationError` (401: invalid key, not logged in), `RateLimitError` (429: too many requests, usage limits), `ConfigurationError` (400, 404: bad key, invalid model), `NetworkError` and `UnknownAgentError`, each with `code`, `status` and `isRetryable` | `[src]` (`errors.d.ts`) |

### Where a class can come from

| cause | claude | codex | pi | opencode | kimi | grok | antigravity | cursor |
|---|---|---|---|---|---|---|---|---|
| missing login | `error` + null status | info 401 | prompt refusal | text | open -32000 | open -32000 | open -32000 | text |
| invalid key | `error` + 401 | info 401 | status in text | text | prompt -32000 | `error_type: auth` | nothing | open 401 |
| unknown model | `error` + 404 | info 404 | open (oar) | open -32602 | open -32603 | open -32602 | open -32602 | not observed |
| rate limited | `error` + 429 | info 429 | status in text | text | nothing | -32003 | nothing | not observed |
| usage limit | 400 only; a subscription's: `error` + `rate_limit_event` `[sym]` | info | status in text | text | nothing | -32003 | nothing | not observed |
| billing | `error` (400 text) or 402 | info | status in text | text | nothing | -32003 | nothing | not observed |
| server error | `error` + 500 | info | status in text | text | nothing | `error_type: api` | text | not observed |
| overloaded | 529 | info | status in text | text | nothing | `error_type: api` | nothing | not observed |
| oversized context | `terminal_reason` | info (in stream) | `isContextOverflow` | nothing | nothing | `error_type: context_length` | nothing | not observed |

"info" is `codexErrorInfo`; "text" is a message that only prose matching can
read; "nothing" means the turn looks completed or never ends.

### When a limit resets

A `quota` failure carries `resetsAt` (a `UtcInstant`) only where the runtime
reports, for that failure, when the limit that refused it resets: never
derived from an account-usage read, a usage snapshot, a retry delay or the
runtime's prose. It is the runtime's last report, which may predate the
failure: a time already past means the reset is unknown (oar reads no
clock for it). It is a fact for the host; oar does not continue the session
when it passes. Only claude reports one.

| runtime | what it reports | `resetsAt` |
|---|---|---|
| claude | `rate_limit_event` `{status, resetsAt (unix seconds), rateLimitType, overageStatus, …}` whenever its view of a claude.ai subscription's limits changes, a refused request included, before the turn's error frame (`rate_limit`, 429) and `result` `[src]` (Agent SDK 0.3.295 `SDKRateLimitInfo`) `[sym]` (2.1.289); none on an API key | a failure claude categorizes `rate_limit` while its latest event says `rejected`, overage does not take the requests (`overageStatus` absent or `rejected`) and it names `resetsAt`: `quota` with that `resetsAt`; otherwise `rate_limited` with none. From the types and the binary only, never observed ([claude](../runtimes/claude.md#usage-limits)) |
| codex | `usageLimitExceeded` carries no data; the time is only in the message, in codex's local time to the minute ("Try again at 3:05 PM.") `[src]`, which oar does not parse. Matching an `account/rateLimits/updated` snapshot to the failure would be inference, so oar does not | none |
| pi, pi-durable | the provider's error text; for a ChatGPT plan pi-ai words it "Try again in ~N min." `[src]` (pi-ai 1.1.0) | none |
| opencode, kimi, grok, antigravity | nothing in the observed answers (above) | none |
| cursor | `RateLimitError` has `code`, `status` and `isRetryable`, no time `[src]` (`errors.d.ts`, 1.0.37) | none |

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
ACP also emits `runtime_refused` when an accepted steer's native RPC later
fails, preserving its error frame without changing the active turn outcome.
Claude, Pi and OpenCode v1 retain the tested interrupted steering input;
Cursor hands undelivered steering back as a refused control. Grok can
lose a just-submitted steer, but its cancellation receipt cannot yet
prove whether that input had been read, so OAR makes no discard claim.
[The audit](../../experiments/input-interruption-2026-10-08.md) records
native versions, evidence and verification limits. Kimi and Antigravity
have no `steer` member. Independent of runtime, an observed process exit
settles inputs still awaiting echoes as `dropped: runtime_exited`, with the
[resume uncertainty](conversation.md#dropped-input) preserved.

## Qwen SDK channel

[Qwen Code](../runtimes/qwen.md) shares the stream-json fold but has its own
initialization, permission reply, effort confirmation and usage policy. It
refuses `outputSchema`, `serviceTier` and `name`. Its native initialize response
precedes full startup; extension-store failure can surface at the first prompt.
On resume, session usage stays unknown because native cumulative totals include
old turns and there is no trustworthy pre-turn session baseline. Context, quota,
inventory and live configuration are not mapped; errors without a native typed
cause remain unknown. Images are refused before write.
