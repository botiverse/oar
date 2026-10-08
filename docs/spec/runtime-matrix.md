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
| claude | `attributed` | frames with `parent_tool_use_id` carry `agentPath = [...parentPath, taskCallId]`, nested through the Task call's own agent; child usage stays unattributed (unverified) |
| codex (app-server) | `nested` | notifications for other thread ids are child-session records (`sessionId` = the thread); a collab item naming the child adds a `tool_call` edge (`subAgentActivity.agentThreadId`). [env] codex 0.149.0: child-thread notifications arrive on the parent's connection (experiments/codex-child-threads.ts) |
| pi | `none` | pi has no native sub-agents; `agentPath` is always root |
| cursor (`@cursor/sdk`) | `attributed` | a child's updates arrive inside the parent's `task` call as `tool-call-delta {callId, taskUpdate}` and carry `agentPath = [...parentPath, taskCallId]` ([env] SDK 1.0.35) |
| grok (ACP) | `nested` | `session/update` for other session ids are child-session records; vendor lifecycle notifications add edges when they name a parent ([sym], unverified live; see [open evidence](#boundaries-and-open-evidence-points)) |
| antigravity (ACP) | `opaque` | the `start_subagent` tool call completes at once; the child's tool calls and text then arrive under the parent's session id (the child's own id survives only as the `toolCallId` prefix), so everything lands on root and nothing is fabricated ([env] agy_acp_server 1.2.1) |
| kimi (ACP) | `opaque` | `kimi acp` subscribes to the main agent only; the adapter records what arrives and fabricates nothing |
| opencode (ACP) | `opaque` | `opencode acp` forwards only its own sessions' parts; a `task` subagent runs in a child session whose frames never reach the transport, so only the parent's tool call shows ([src] opencode 1.18.34 `acp/event.ts`) |

| runtime | sub-agent exposure | linkage | per-agent tokens | session graph | resume | evidence |
|---|---|---|---|---|---|---|
| claude | native subagent messages can share the stream | `parent_tool_use_id` | current transport's child usage attribution unverified | `agentPath` (not in graph) | native session id | [native/current mapping](../runtimes/claude.md) |
| codex (app-server) | native child threads and collaboration items on the parent's connection | `senderThreadId` / `receiverThreadIds`; `subAgentActivity.agentThreadId` ([env]: `started` on the root names the child, `interacted` on the child names the root) | both threads report their own running total in `thread/tokenUsage/updated`; the child's is in its own session's records, not in the root `usage()` ([env]); the root's counts from when the Session opened ([#169](attribution.md#usage-one-constraint)) | native thread topology; child threads are child sessions | `threadId`; `expectedTurnId` is a steer precondition | [pinned schema/current mapping](../runtimes/codex.md) |
| pi | no native (host composes) | host-nested sessions | flat (host splits) | no runtime-reported edges | session id | [src] |
| cursor (`@cursor/sdk`) | wrapper records (#2) in the parent run's updates | the `task` call id on `tool-call-delta` | each run's `turn-ended` usage is the root's; none seen for a child ([env]) | `agentPath` (not in graph) | `agentId` | [native/current mapping](../runtimes/cursor.md) |
| grok (ACP) | nested sessions (#3), same connection | child has its own ACP sessionId | child usage lands in the child session's records ([src]; live unverified) | parent→child session edges (in graph, [sym]) | ACP `sessionId` | [native/current mapping](../runtimes/grok.md) |
| antigravity (ACP) | opaque (#1): child activity flattened onto the parent session | `start_subagent` tool card only; child id only as a `toolCallId` prefix | no usage reported for any session ([env]) | nothing fabricated | ACP `sessionId` | [native/current mapping](../runtimes/antigravity.md) |
| kimi (ACP) | opaque (#1): default subscribes main agent only | root `Agent` tool card only | no typed child usage exposed | nothing fabricated from display text | ACP `sessionId` | [native/current mapping](../runtimes/kimi.md) |
| opencode (ACP) | opaque (#1): child sessions not forwarded | root `task` tool card only | no child usage exposed | nothing fabricated | ACP `sessionId` (opencode `ses_` id) | [native/current mapping](../runtimes/opencode.md) |
| kimi-cli (native wire) | wrapper records (#2): `SubagentEvent`, one stream | `parent_tool_call_id` + `agent_id` + `subagent_type` | child events self-attribute | `agentPath`, recursive (not in graph) | session / agent_id | [src] |
| kimi-code (native KAP) | agent graph (#2): key = `(session_id, agent_id)` | `subagentId` + `parentAgentId` + `parentToolCallId` + `runInBackground` | `subagent.completed` carries usage | `agentPath` (not in graph) | session / agent_id | [src] |

## Session controls

`prompt`, `queue` and `abort` are on every session. `steer` and `withdraw`
are members a session may lack: a control the runtime cannot do is an
absent member, never a request that is always rejected
([record stream](record-stream.md#the-rules)). Where `queue.durable` is
false, the adapter holds queued input in this process.

| runtime | `steer` | `withdraw` | `capabilities.queue.durable` |
|---|---|---|---|
| claude | yes: a user message written to stdin mid-turn | yes | no |
| codex | yes: `turn/steer` with `expectedTurnId` | no: the queue is codex's own (`thread/queue/add`; [why](record-stream.md#withdrawing-held-input)) | yes |
| pi | yes: the SDK session's `steer` | yes | no |
| cursor (`@cursor/sdk`) | yes, text only: `run.steer` (images are rejected `unsupported`) | yes | no |
| grok (ACP) | yes: a prompt RPC with `_meta.sendNow` | yes | no |
| kimi (ACP) | no | yes | no |
| antigravity (ACP) | no | yes | no |
| opencode (ACP) | yes: a plain prompt RPC mid-turn, which joins the running loop at its next step; both prompts are answered at idle | yes | no |

## Tool outcomes

Native sources for the `tool_call_ended` fields (the rule that they are
never derived is in [record-stream.md](record-stream.md#the-rules)):

| runtime | `content` from | `result` from | `exitCode` from |
|---|---|---|---|
| claude | `tool_result.content` (a string or blocks) | stream-json `tool_result.is_error`, optional and false by default in the Messages API, so an absent field is `ok` ([src]; 2.1.288 omits it on successful Read, Write and Edit) | none (`tool_use_result` carries no exit status) |
| codex | `commandExecution.aggregatedOutput`; an MCP call's result blocks (an error as its message); `webSearch` results as one `other` part; else the item's status word | `item/completed.status` `completed`/`failed` ([src]) | `commandExecution` items' `exitCode` ([src]) |
| pi | `tool_execution_end.result.content` blocks, else the whole result | `tool_execution_end.isError` false/true ([src]) | none |
| grok, kimi, antigravity, opencode (ACP) | the closing `tool_call_update.content` blocks, else `rawOutput`; text parts are cut at 10,000 characters (`native` keeps them whole) | `tool_call_update.status` `completed`/`failed` ([src]) | `rawOutput.exit_code` on the closing `tool_call_update`: grok ([src] grok 1.0.25), antigravity ([env] agy_acp_server 1.2.1) |
| cursor (`@cursor/sdk`) | a shell call's stdout and stderr (one empty text part when it printed nothing), a read's file text, an edit's or write's diff, an error's message, else one `other` part ([env] SDK 1.0.35) | `tool-call-completed` `toolCall.result.status` `success`/`error` ([env] SDK 1.0.35) | a shell call's `result.value.exitCode`, `null` when `signal` names one ([env]) |

A frame without the corresponding native field leaves the key absent; the
native frame stays verbatim beside the event.

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
Claude's `CLAUDECODE` marker is always removed. Child-process and native Pi
Bash regressions: [session-env.test.ts](../../tests/session-env.test.ts),
[pi-env.test.ts](../../tests/providers/pi-env.test.ts).

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
| antigravity | canonical `BuiltinTools` filter names via `_meta.agy.disabledTools`; see its page for the exact list and native group names | MCP, client file tools, unknown names; a mixed list fails as a whole before launch |
| grok, kimi, opencode | none through the selected OAR transport | every non-empty list, declared in `Runtime.refusedSessionOptions` |

Value-specific refusals identify the offending names. They are not listed
as an always-refused option on codex, cursor or antigravity. The native
channels, observed versions and limits are in the
[October 8 audit](../../experiments/disallowed-tools-2026-10-08.md). Supply
the list again when resuming; OAR does not persist host options.

## Launch arguments

`SessionOptions.launchArgs` adds the host's own command-line arguments to
the runtime process a session starts, for a flag OAR does not model (codex
`-c service_tier="fast"`, claude `--add-dir`). OAR passes them unchecked:
it promises nothing about their effect, a runtime can ignore one it does
not know, and one that changes the protocol OAR speaks breaks the session.
They are never recorded. Give them again on resume.

| runtime | where they go |
|---|---|
| claude | after OAR's own flags, before `--mcp-config` and `--disallowed-tools` (both take several values) |
| codex | `app-server`, OAR's `-c` overrides, the host's arguments, `--listen stdio://` |
| grok | `agent --always-approve --no-leader`, the host's arguments, `stdio`: `agent` takes its options before `stdio` |
| kimi, opencode | after `acp` |
| antigravity | after OAR's own arguments |
| pi, cursor | refused: they run in the host process through their SDKs, with no command line |

## Claude partial output

Claude requests partial output for new and resumed sessions: text/thinking
deltas project immediately with the native API message ID; completed blocks
do not repeat them. Tool-argument chunks remain raw activity until the full
call arrives. See [Claude observation](../runtimes/claude.md#observation-children-and-history).

## Refused session options

What a runtime cannot honor is refused, never dropped: `session()` rejects
with an `UnsupportedOptionError` whose `option` names the refused
`SessionOptions` key and whose message is the reason, rather than open a
session that quietly runs without it. A host may simply try and fall back
on that error, and tells it from a failed login or a network error without
reading the message.

`Runtime.refusedSessionOptions` declares, before any session opens, the
`SessionOptions` a runtime refuses when given (`env`, `mcpServers`, `disallowedTools`, `launchArgs`: a
non-empty one), each with that reason. The adapter checks the same map, so
the declaration and the refusal cannot drift
(`tests/refused-session-options.test.ts`). A host leaves a declared option
out instead of naming runtimes.

| runtime | refuses | why |
|---|---|---|
| cursor | `systemPrompt`, `appendSystemPrompt`, `env`, `mcpServers`, `launchArgs` | the SDK's local agent fails a run given a system prompt and has no append; it runs in the host process with no environment or command line of its own; its agent runs on Cursor's servers, and no run without a login or paid tokens shows it calling a tool of `Agent.create`'s `mcpServers` ([cursor](../runtimes/cursor.md#session-mcp-servers)) |
| kimi | `systemPrompt`, `appendSystemPrompt`, `disallowedTools` | `kimi acp` has no per-session prompt input; its launcher does not forward the CLI's agent-profile flags, and has no session tool-denial overlay ([audit](../runtimes/kimi.md#models-instructions-and-context)) |
| antigravity | `systemPrompt`, `appendSystemPrompt` | the selected server has no prompt input in its protocol, launcher or configuration ([audit](../runtimes/antigravity.md#models-instructions-and-context)) |
| grok | `disallowedTools` | the top-level CLI denylist is not forwarded to `agent stdio`; replacing the selected agent profile is not a tool overlay |
| opencode | `disallowedTools` | agent permissions can override global denies; permission names do not consistently match tool names |
| pi | `launchArgs` | it runs in the host process through its SDK, with no command line |
| claude, codex | nothing always refused | codex has value-specific tool-name refusals below |

`mcpServers` is refused until a runtime's channel is shown to make its agent
call an attached server's tool, with the evidence on its runtime page
([#170](https://github.com/botiverse/oar/issues/170)). Where it is taken:

| runtime | channel | stdio | http | resume | a name the user's config also has |
|---|---|---|---|---|---|
| claude | `--mcp-config <path>`: a 0600 FIFO removed once claude has read it (a 0600 file removed when the process ends on Windows); no `--strict-mcp-config` | yes | yes | the flag again | the session's server replaces the user's for that process ([claude](../runtimes/claude.md#session-mcp-servers)) |
| codex | `config.mcp_servers` on `thread/start` and `thread/resume` | yes | yes | the override again | merged into the user's entry field by field; oar's `command` / `url`, `args` and `enabled = true` win ([codex](../runtimes/codex.md#session-mcp-servers)) |
| grok | ACP `mcpServers` on `session/new` and `session/resume`; the model reaches the tools through grok's `use_tool` | yes | yes | the param again | the session's replaces the user's `config.toml` entry; the user's others stay ([grok](../runtimes/grok.md#session-mcp-servers)) |
| kimi | ACP `mcpServers` on `session/new` and `session/resume` | yes | yes | the param again | the session's replaces the user's `mcp.json` entry; the user's others stay ([kimi](../runtimes/kimi.md#session-mcp-servers)) |
| opencode | ACP `mcpServers` on `session/new` and `session/resume`, held by that opencode process | yes | yes | the param again | the session's replaces the user's `mcp` entry for that process (a session server that fails to start removes it); the user's others stay ([opencode](../runtimes/opencode.md#session-mcp-servers)) |
| antigravity | ACP `mcpServers` on `session/new` and `session/resume`, started at the first prompt; the model calls them through `call_mcp_tool`. An entry with `env` or `headers` is refused: the server would store their values in plain text in its conversation database | yes | yes | the param again | the session's replaces the user's `mcp_config.json` entry; the user's others stay ([antigravity](../runtimes/antigravity.md#session-mcp-servers)) |
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
`tests/replay/fixtures/{claude,codex,pi}-mcp-echo.raw.jsonl`. A list naming a
server twice, or with an empty name, is a plain error before anything starts,
as is a name codex (`^[\w:@/.-]+$`) or pi (`^[\w-]+$`, and two names pi folds
into one tool namespace) would not take. A transport a runtime cannot attach
is an `UnsupportedOptionError` on `mcpServers`: an http entry on an ACP agent
whose `initialize` declares no `mcpCapabilities.http`; every runtime above
attaches both. So is an entry with a non-empty `env` or `headers` on
antigravity, which would write them to its disk: a conditional refusal, not
an always-refused option declaration.

OpenCode carries prompt options through native inline configuration. An
already-defined `OPENCODE_CONFIG_CONTENT` refuses either prompt option, and
an empty replacement is refused because native OpenCode selects its built-in
prompt for that value ([evidence](../runtimes/opencode.md#models-effort-instructions-and-context)).
These are conditional refusals, not always-refused option declarations.

Grok refuses an append-only prompt change on resume: native `rules` is not
reapplied. A `systemPrompt`, with or without `appendSystemPrompt`, is supported
on resume ([request evidence](../runtimes/grok.md#models-and-instructions)).
This conditional refusal is not an always-refused option declaration.

Kimi and opencode also refuse a `resume` that names another directory than
the one their `session/list` says the session lives in (option `cwd`): they
would run the session in its own directory instead. Only the runtime knows the
session's directory, so this refusal is not declared up front; it is the
same error ([resume in another directory](../runtimes/resume-cwd.md)).

An ACP runtime whose session advertises no `thought_level` config option
has no effort channel, so it refuses `effort` with the same error once its
handshake shows that (antigravity, [env] agy_acp_server 1.2.1;
`shared/acp/effort.ts`, `tests/acp/acp-session-antigravity.test.ts`). The
menu belongs to the model in effect: opencode offers one only for a model
with variants, so after a requested model switch the switch's answer is
read, not the open's ([env] opencode 1.18.30). A
level a runtime does not offer is a plain error naming the level, not this
one.

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

Only `[env]` cells are mapped. A value a runtime declares that no run
produced stays unmapped (it falls through to the status or to `unknown`)
until it is observed: claude's `oauth_org_not_allowed`, `account_on_hold`,
`verification_required`, `overloaded`, `max_output_tokens`,
`cloud_credential_error`; codex's `unauthorized`, `badRequest`,
`sessionBudgetExceeded`, `cyberPolicy` and the rest of its schema; Anthropic's
`request_too_large` and `permission_error`; OpenAI's spend-limit and
`slow_down` codes.

`credential` is set only where the runtime makes it plain: claude's
`authentication_failed` with no request sent (`missing`) or a 401
(`rejected`), and cursor's `AuthenticationError` at open (`rejected`).
ACP's -32000, a codex 401 and a pi 401 do not say which. `status` is the
HTTP status where the runtime reports one.

Known blur, kept because the runtime does not tell the causes apart: codex's
`usageLimitExceeded` covers a usage limit and an exhausted balance alike
(`quota`); claude's 429 covers a tier's monthly spend cap as well as
throttling (`rate_limited`); grok's -32003 covers every 429 (`rate_limited`).
kimi and antigravity report most failed turns as completed, so oar does too.

An open fails with a `RuntimeFailureError` (`failure`, `credential`,
`status`, `reason`) for: ACP's -32000 on `initialize`, `authenticate`,
`session/new` or `session/resume` (`auth`); an invalid-params answer (-32602)
to the call that selects the model (`model_unavailable`); cursor's
`AuthenticationError` (`auth`, `rejected`); a pi model oar does not find in
pi's registry (`model_unavailable`). Other open failures keep their errors
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
subscription's limits arrive as `rate_limit_event` frames `[sym]`, not observed.

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
| unknown model | `{httpConnectionFailed: {httpStatusCode: 404}}` | 5 | `model_unavailable` (the status) |
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
| usage limit | 400 only | info | status in text | text | nothing | -32003 | nothing | not observed |
| billing | `error` (400 text) or 402 | info | status in text | text | nothing | -32003 | nothing | not observed |
| server error | `error` + 500 | info | status in text | text | nothing | `error_type: api` | text | not observed |
| overloaded | 529 | info | status in text | text | nothing | `error_type: api` | nothing | not observed |
| oversized context | `terminal_reason` | info (in stream) | `isContextOverflow` | nothing | nothing | `error_type: context_length` | nothing | not observed |

"info" is `codexErrorInfo`; "text" is a message that only prose matching can
read; "nothing" means the turn looks completed or never ends.

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

`input_dropped` is currently emitted by Codex only: an interrupted root
turn drops that turn's accepted, un-echoed steers before `turn_ended`.
Claude, Pi and OpenCode retain the tested interrupted steering input;
Cursor hands undelivered steering back as a refused control. Grok can
lose a just-submitted steer, but its cancellation receipt cannot yet
prove whether that input had been read, so OAR makes no discard claim.
[The audit](../../experiments/input-interruption-2026-10-08.md) records
native versions, evidence and verification limits. Kimi and Antigravity
have no `steer` member. Independent of runtime, an observed process exit
settles inputs still awaiting echoes as `dropped: runtime_exited`, with the
[resume uncertainty](conversation.md#dropped-input) preserved.
