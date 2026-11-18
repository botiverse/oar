# Factory Droid

## Native programming interface

Factory's `droid` CLI has its own programmatic protocol:
`droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`.
It is JSON-RPC 2.0 over stdin and stdout, one message per line, with Factory's
additions on every message: `type` (`request`, `response`, `notification`)
and `factoryApiVersion: "1.0.0"`; droid also stamps `factoryProtocolVersion`
(1.340.0 on droid 1.12.1). Ids are strings. Factory's TypeScript SDK,
`@factory/droid-sdk`, starts the same command and speaks the same protocol.
One process serves one current session; no method names the session.

| Concept | Native form |
|---|---|
| Open | `droid.initialize_session { machineId, cwd, modelId?, reasoningEffort?, systemPrompt?, mcpServers?, skipPermissionsUnsafe?, ... }` answers `{ sessionId, settings, availableModels, ... }` |
| Resume | `droid.load_session { sessionId, mcpServers?, messageLimit? }` in a new process; `-32004` when droid has no such session |
| Input | `droid.add_user_message { text, messageId, images? }` answers `{}` at once; the `messageId` becomes the turn id |
| Turn end | the notification `agent_turn_completed { turnId, reason, tokenUsage, childTokenUsage, ... }`; `reason` has 19 values |
| Events | `droid.session_notification { sessionId?, notification: { type, ... } }`: text and thinking deltas, `tool_call`, `tool_result`, `create_message`, settings, queue, working state, errors, retries |
| Cancel | `droid.interrupt_session {}` |
| Requests to the client | `droid.request_permission`, `droid.ask_user`, `droid.pick_options` |
| Skills | `droid.list_skills { includeContent: false }`, before any session |
| Models | `droid.list_models` (also before any session, without a login) |
| Context | `droid.get_context_stats` answers `{ used, remaining, limit, accuracy }` |

droid also has an ACP mode (`droid exec --output-format acp`). OAR uses it only
for the account: the stream-jsonrpc protocol has no login, status or logout
method, and the ACP entry is where droid offers them (see [Login](#login)).

Current check: **droid 1.12.1** (Linux arm64, 2026-11-15): all 19
behavior cases and eight native vendor cases pass against a local provider, with
no Factory account ([probes](../../experiments/factory-droid/README.md)). CI
runs them on Linux and macOS, pinned to droid 1.12.1. Windows is not yet
verified. No Factory account has run a turn through OAR yet: Factory's own
models, a real limits answer and a completed sign-in are unverified.

## OAR mapping

`factoryRuntime` (id `factory`, brand "Factory Droid") is in `defaultRuntimes`
and has the `@botiverse/oar/runtimes/factory` entry.

### Installation and updates

OAR finds `OAR_FACTORY_BIN`, `droid` on PATH, or `~/.local/bin/droid`, and
requires `droid exec --help` to run. `installPlan()` describes Factory's
script, `curl -fsSL https://app.factory.ai/cli | sh`, which downloads the
release for this OS and CPU from `downloads.factory.ai`, checks its SHA-256 and
copies it to `~/.local/bin/droid`; `install()` runs it on macOS and Linux only
when no usable copy is found. On Windows the plan names Factory's PowerShell
installer, which OAR does not run. `checkUpdate()` reads `droid update
--check` ("Update available: X" or "Already up to date!"); `upgrade()` runs
`droid update`. The npm package `droid` is the same release; OAR's CI installs
it from npm.

### Skills

`skills()` reads `droid.list_skills { includeContent: false }` in a separate
native process without initializing a session or sending a prompt. It returns
`view: "discovered"`, including builtins and disabled or non-user-invocable
skills. Native location is preserved as `source`; personal, project, builtin
and automation map to user, project, builtin and other scopes. Native plugin
identity, enabled state and `userInvocable` are copied when present. User invocation is not
model invocation, so `disableModelInvocation` remains absent.

The answer is complete unless native `projectAvailable` is false. Native
method absence is unsupported; malformed answers and query failures are
unavailable, without exposing raw diagnostics. Startup can access the network
and create caches, logs and other native state. It is not a local-only read.
Both droid 1.12.1 and 1.13.0 were checked on Linux, including pre/post-session
parity, unchanged settings and no provider requests. The reader owns and
awaits its process cleanup. [Evidence and reproduction](../../experiments/factory-skills/README.md).

### Sessions

One `droid exec` stream-jsonrpc process per session. Every native line is one
record, whole and in arrival order. A notification is a frame whose `type` is
its notification `type` (or its method). Every reply to a request OAR sent
(`initialize_session`, `load_session`, `update_session_settings`,
`add_user_message`, `interrupt_session`, `get_context_stats`,
`compact_session`), error replies included, is a frame named after the method,
recorded whole where it sat on the wire; replies to an input or an abort name
that control's request in `responseTo`, and a refusal settles the input at
that point, before any later line is read. A response no request owns is a `response` frame, and a line that
is not JSON a `stdout` frame.

- **Open.** `initialize_session` with the session's `cwd`, `modelId`,
  `reasoningEffort`, system prompt and MCP servers, and
  `skipPermissionsUnsafe: true` (OAR's YOLO default, contracts/session.ts).
  `Session.id` is droid's `sessionId`.
- **Model and effort.** droid's reported `settings` decide. droid runs its
  default model in place of an unknown one and clamps an effort the model does
  not list, without an error, so OAR compares the reported `modelId` and
  `reasoningEffort` with the request and refuses the open on a difference: a
  model is `ModelConfirmationError` (`requested`, `reported`; no catalog is
  read for this check), an effort `UnsupportedOptionError` on `effort`, and so
  is droid's own -32602 refusal of an effort outside its enum.
  `model` and `effort` events come from the open answer and every
  `settings_updated`.
- **Resume.** `load_session` in a new process. An unknown id is
  `SessionNotFoundError` (`-32004`). A session saved for another directory is
  refused with `ResumeCwdError` (`reason: "other_cwd"`, with `savedCwd`) after the
  load answer names that directory. When `model` or `effort`
  differ from what the session saved, OAR sends `update_session_settings` and
  takes the next `settings_updated` as droid's word, refusing the open on a
  difference. `load_session` takes no system prompt, so `systemPrompt` and
  `appendSystemPrompt` are refused on resume.

### Prompting, steering, queueing and abort

- **prompt** sends `add_user_message` with `messageId` set to the input id
  (generated when the host gives none) and the OAR request id as its JSON-RPC
  id. droid answers `{}` at once; that answer accepts the prompt. The turn
  ends at `agent_turn_completed` with that `turnId`.
- **steer** is droid's own steering: a second `add_user_message` during the
  turn. droid queues it (`end_of_turn`), drains it into the running turn after
  the model's current step, and echoes it as a user `create_message` under its
  `messageId`. The turn still ends once, under the first turn id. OAR reports
  the echo as `user_message` with `evidence: "turn_item"`, linked by the RPC id
  and the message id OAR chose.
- **queue** is held by OAR (`capabilities.queue.durable: false`) and sent as
  a new prompt when the session is idle; **withdraw** takes a held input back
  before it is sent.
- **abort** sends `interrupt_session`; its answer accepts the abort, and the
  turn ends `cancelled` (`aborted`). Steering droid had not drained yet is
  discarded (`queued_messages_discarded`, naming the RPC ids): OAR reports
  `input_dropped` with `reason: "turn_interrupted"` for each such steer. An
  interrupt that reaches droid before it started the prompt hands the prompt
  back (`queued_message_handed_back`): OAR reports `input_dropped` for the
  prompt, and the session takes a new prompt before droid's late `cancelled`
  turn end arrives (turn ends are matched by turn id). If
  droid does not end the aborted turn within 10 seconds, OAR stops the process
  and records its exit; only that turn's end, or droid handing its prompt
  back, disarms this, so another turn's end neither disarms it nor lets a
  stale one stop a later turn.
- A steer that reaches droid as its turn ends can miss it: droid ends the turn
  without echoing the steer, then runs the steer as a turn of its own
  (reproduced on 1.12.1 with a steer sent within about 50 ms of the turn's
  end). When a turn ends while a steer OAR sent is neither echoed nor given
  back, OAR records `turn_active` for that steer in the same frame and keeps
  the session busy until droid ends the steer's turn: a prompt is `busy`, held
  input waits. An interrupt in that gap makes droid hand the steer back
  (`queued_message_handed_back`) and, on 1.12.1, end the steer's turn about
  20 ms later as `cancelled` under the steer's id (probed with the custom-model
  setup). OAR frees the session at the handback and disarms that abort's
  fallback there, so neither a late end nor its absence can stop a newer turn.

### Events, tools and permissions

| Native | OAR event |
|---|---|
| `assistant_text_delta` | `text_delta` with droid's `messageId` |
| `thinking_text_delta` | `reasoning` text |
| first `tool_call` for an id | `tool_call_started` (input as JSON) |
| later `tool_call` for that id (droid streams the input) | `tool_call_input` |
| `tool_result` | `tool_call_ended` with droid's content and `isError` as `result` |
| user `create_message` for an input OAR sent | `user_message` |
| `queued_messages_discarded` | `input_dropped` |
| `llm_retry` | `retry` |
| `session_compacted` | `compaction_ended` |
| `agent_turn_completed` | `usage`, then `turn_ended` |

`assistant_message_retracted` stays a native frame: OAR has no event that
takes streamed text back. droid's `tool_result` carries no exit code field, so
none is reported.

Permission: new sessions open with `skipPermissionsUnsafe`, so droid asks
nothing. A resumed session does ask (`load_session` has no such flag): OAR
answers each `droid.request_permission` with `proceed_once` and never with a
standing grant (`proceed_always`, `proceed_auto_run_*`, ...). Without
`proceed_once` on offer it chooses droid's `cancel`, and with neither it
answers an error rather than a value droid did not offer. OAR records the
request and its answer. `droid.ask_user` and
`droid.pick_options` are answered as cancelled: nobody sits at a prompt in
embedded use.

### Children

droid runs `Task` sub-agents in child sessions (`child_session_available`).
This adapter declares attribution `opaque`: it records what the root stream
carries and links no child sessions. Child tokens arrive as `childTokenUsage`
on the parent's turn end (below).

### Usage and context

`agent_turn_completed.tokenUsage` is the turn's own count, droid's title
request on a session's first message included. OAR sums it from when the
session opened: `input` is `inputTokens` plus the cache parts droid reports
beside it (`cacheReadTokens`, `cacheCreationTokens`), `output` is
`outputTokens`. `thinkingTokens` stays in the native frame: whether
`outputTokens` already includes it is not established without a Factory model.
Once a turn reports sub-agent tokens (`childTokenUsage`), the usage report's
`total` adds them. After each turn and at open, OAR reads
`get_context_stats` and records it as a `usage` frame with `context`
(`used` of `limit`).

### Failures

`agent_turn_completed.reason` decides first: `model_usage_exhausted` is
`quota`, `model_rate_limited` `rate_limited`, `model_authentication_failed`
`auth`, `model_request_rejected` and `prompt_rejected` `invalid_request`,
`model_provider_unreachable` and `model_provider_unavailable` `provider`,
`structured_output_*` `output_schema`, `process_exit` `runtime_exited`;
`cancelled` is an aborted turn and `completed` or `spec_handoff` a completed
one. Any other failing reason is classified from droid's last `error`
notification of the turn, which is also the reason text. No reset time is
reported.

### Session options

| Option | Mapping |
|---|---|
| `model`, `effort` | `modelId`, `reasoningEffort`, read back (above) |
| `systemPrompt` | `systemPrompt` (a string replaces droid's prompt); refused on resume |
| `appendSystemPrompt` | `systemPrompt: { type: "preset", preset: "droid", append }`; with `systemPrompt`, appended to it; refused on resume |
| `mcpServers` | `mcpServers` on open and resume (below) |
| `env` | the process environment |
| `launchArgs` | after OAR's own arguments; the protocol, session and cwd flags are refused |
| refused | `serviceTier` (none), `outputSchema` (droid's `structuredOutputFormat` not yet verified across turns), `name` (title persistence not verified), `additionalDirectories` (none), `disallowedTools` (`disabledToolIds` not yet verified against these names), `userConfiguration: "exclude"` (no verified separation), `goals`, `endTurnProcessesOnAbort` |

#### Session MCP servers

droid takes stdio servers (`env` as a record) and streamable HTTP servers
(`headers` as name/value pairs) on `initialize_session` and `load_session`.
The model reaches a server's tools as `<server>___<tool>`; droid offers them
through its `ToolSearch` tool and they are callable directly. droid's open
answer echoes the servers, `env` included: the record keeps them only through
OAR's credential redaction. How a running session takes a server's tool-list
change is not measured, and what happens to a same-named server from the
user's configuration is not measured.

### Models

`listModels` asks `droid.list_models` in the listing directory. It answers
without a login: Factory's catalog for the account plus the custom models in
droid's settings, with `supportedReasoningEfforts` as the effort menu and
`defaultReasoningEffort`. droid's default model is not marked: the list does
not say it.

## Login

droid's sign-in is on its own ACP entry, `droid exec --output-format acp`
(1.12.1). Its `initialize` lists `authMethods` `device-pairing` and
`factory-api-key` and `agentCapabilities.auth { logout, status }`.

- **login** starts that entry, declares `clientCapabilities.elicitation.url`
  and sends `authenticate { methodId: "device-pairing" }`. droid answers with
  `elicitation/create { mode: "url", url }`: Factory's device page with the
  pairing code in it. OAR relays it as an `auth_url` event (droid's message as
  `instructions`) and accepts it; droid polls until the person confirms, stores
  the login and answers the `authenticate`. droid opens no browser on this
  path. OAR then reads `auth/status` on the same process: logged out is
  `not_logged_in`, and so is a sign-in stored while `FACTORY_API_KEY` is set,
  since droid keeps using the key. A refusal is `rejected` with droid's words, any URL removed.
  Deadline 15 minutes.
- **authStatus** reads `auth/status`: `unauthenticated` is `logged_out`,
  `authenticated` is `logged_in` (`credential: "account"`). With
  `FACTORY_API_KEY` set, droid uses the key instead of any stored login and
  reports it as authenticated without checking it, so OAR answers `unknown`
  with `configured: ["FACTORY_API_KEY"]`. At its deadline the read answers
  `unknown` at once; stopping droid continues in the background.
- **logout** sends droid's `logout` and reads `auth/status`: logged out is
  `logged_out`; a set `FACTORY_API_KEY` is `still_logged_in`.

Verified on 1.12.1 without an account: status logged out, the key case, the
login up to the URL (then cancelled) and logout. A completed sign-in with a
Factory account, and what `auth/status` reports for it (the account label is
not mapped to an email until seen), are not yet verified.

## Manual compaction

`manualCompaction` is `{ kind: "supported", activeTurn: "reject" }`.
`Session.compact()` sends `droid.compact_session {}` with the compact request
id as its JSON-RPC id. Probed on 1.12.1 with a custom model: droid summarizes
in the same session (`newSessionId` equals the session id, and a later
`load_session` of that id holds the compacted history), reports
`session_compacted { summaryId, removedCount }` and then answers `{
newSessionId, removedCount }`. While that call is pending, OAR tags the
`session_compacted` frame's `compaction_ended` with the request id, and the
answer frame settles the operation (`settledBy: "native_response"`):
`completed` with the `session_compacted` frame. droid refuses a compaction
during a turn (-32602 "Wait for the current turn to finish before
compacting.") and OAR answers `busy` before sending one; on an empty
conversation droid's refusal ("Nothing to compact") is `rejected`
`runtime_refused`. An answer naming another session would be a `failed`
operation: that id would no longer name this session. A compaction droid
starts on its own (its threshold) reports `session_compacted`, read as
`compaction_ended` without a request id.

## Account usage and limit resets

`accountUsage` reads what droid's own usage screen reads: `GET
<api>/api/billing/limits` with `Authorization: Bearer <credential>`,
`X-Factory-Client: cli`, `X-Client-Version` and, for a signed-in user,
`X-Factory-Org-Id`. `<api>` is `FACTORY_API_BASE_URL` (default
`https://api.factory.ai`), or `FACTORY_API_BASE_URL_EU` (default
`https://api.eu.factory.ai`) for a login droid routed to region `eu`; droid
honors the same variables.

The credential is the one droid would send, read as stored and never
refreshed or written. droid's directory is resolved as droid resolves it:
`FACTORY_HOME_OVERRIDE` when set, else the home directory (`HOME`, or
`USERPROFILE` on Windows), then `.factory`.

- `FACTORY_API_KEY` when set (in `options.env` or the host's), which droid
  uses over any stored login; its region comes from droid's own cache for that
  key (`~/.factory/api-key-identity/seed.json`), else the global API.
- Otherwise droid's "keyfile" login: `~/.factory/auth.v2.file`, AES-256-GCM
  encrypted with `~/.factory/auth.v2.key`, holding `access_token`,
  `active_organization_id` and droid's cached region. droid writes it when no
  OS keyring is usable or with `FACTORY_DISABLE_KEYRING=1`.
- A login sealed with an OS keyring key (`auth.v2.keyring`,
  `auth.v2.loginkeychain`) is `unsupported` with `unsupported_auth_storage`.
- No stored login is `reauth_required` with `credentials_missing`. A stored
  access token droid would have refreshed is sent as it is; the API's 401 or
  403 is `reauth_required` with `credentials_rejected`, and running droid once
  refreshes it. 404 is `unsupported` with `endpoint_unavailable`.
- A credential that cannot be an HTTP header value (a control character or
  space) is refused before any request with a message that names no part of
  it, and a failed request keeps no fetch error as its cause, since those can
  quote header values.

The answer has `limits.standard` (Standard Usage) and `limits.core` (Droid
Core), each with `fiveHour`, `weekly` and `monthly` buckets of `{
usedPercent, windowEnd, unlimited? }`. Each bucket becomes a window with
droid's key as `id` (`standard.fiveHour`, `core.weekly`, ...), droid's label,
`usedPercent / 100` as `usedRatio`, `windowEnd` as `resetsAt` and, for the
5-hour and weekly buckets, their length as `durationMs`. Standard windows are
the account's; Droid Core windows are `{ kind: "models", name: "Droid Core" }`.
A bucket without a future `windowEnd` has reset, which droid shows as 0%, and
so does OAR (no `resetsAt`). Unlimited buckets are left out, damaged ones are
omitted, and an answer with none usable rejects. `rateLimited` is a full
Standard window with no Extra Usage to continue on (`overagePreference`
`extraUsage`, `extraUsageAllowed` and a positive `extraUsageBalanceCents`). No
limits and `hasActiveSubscription: false` is `unsupported` with
`quota_unavailable`. A customer-hosted ("prem") deployment is not handled.

**The answer's shape comes from droid's own code** (its usage screen and the
model-switch checks of droid 1.12.1; droid does not schema-check the answer
itself) **and is unverified on a real account.** The tests use a local HTTP
server through `FACTORY_API_BASE_URL`.

There are no limit resets: droid's bundle has no reset or redeem endpoint. A
turn that hits a limit ends with `model_usage_exhausted` or
`model_rate_limited` and is classified as `quota` or `rate_limited`.

## Testing

`OAR_TEST=factory-aimock` runs the behavior suite and the
[vendor tests](../../sea-trial/vendor/factory.vendor.test.ts) on the real
droid with a fresh HOME whose only model is a custom model served by aimock
([fixture](../../sea-trial/harness/factory-aimock.ts)): droid runs whole turns
on it with no Factory login.

## Open gaps

- A real Factory account: Factory's models, `thinkingTokens`, the
  `model_usage_exhausted` path, a completed sign-in, the logged-in status, and
  the `/api/billing/limits` answer.
- Windows.
- Child sessions as linked sessions (`child_session_available`).
- `outputSchema` through `structuredOutputFormat`, `disallowedTools` through
  `disabledToolIds`, session titles.
