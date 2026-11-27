# Bub

**Community runtime**, maintained by [@wey-gu](https://github.com/wey-gu).
Verified against the real `bub acp` with a scripted model provider (the
shared behavior suite and a raw ACP probe) and with DeepSeek's own API,
2026-11-27; not yet against another provider or a Bub OAuth login.

It lives in `packages/oar/src/community/bub/` and is exported from
`@botiverse/oar/community`, not `defaultRuntimes`; a host adds it with
`createRuntimeRegistry([...defaultRuntimes.list(), createBubRuntime()])`.
The `oar` CLI includes it. The scripted unit tests are in
`tests/community/bub/`; set `OAR_COMMUNITY_TESTS=1` to include them in a
local unit run.

Evidence baseline: `bub 0.6.3.dev1+gb2e54493a` with `bub-acp-server`
0.1.0 (agent-client-protocol 1.1.0) and Republic 0.6.4, as the official
installer's `acp` preset installs them, and native source
[`bubbuild/bub`](https://github.com/bubbuild/bub) at `b2e54493` and
[`bubbuild/bub-contrib`](https://github.com/bubbuild/bub-contrib)
(`packages/bub-acp-server`). Live observations come from
[`experiments/bub-acp-probe.ts`](../../experiments/bub-acp-probe.ts)
([evidence](#evidence-and-verification)). Versions are evidence baselines,
not a support range.

## Native concepts and calling interfaces

Bub is a small Python agent runtime built from plugins (hooks, tools,
skills and channels), with a REPL (`bub chat`), one-shot runs (`bub run`),
message gateways and an ACP server. Its state lives in `BUB_HOME`
(default `~/.bub`): the config file, the plugin environment the installer
creates, and **tapes**, the append-only histories every session reads and
writes.

- A **model** is `provider:model` (`BUB_MODEL`, default
  `openrouter:openrouter/free`), served by Republic's providers (anthropic,
  deepseek, gemini, openai, openrouter and more). Keys and endpoints are
  environment variables: `BUB_<PROVIDER>_API_KEY` or `BUB_API_KEY`,
  `BUB_<PROVIDER>_API_BASE` or `BUB_API_BASE`.
- Settings come from the environment, then a `.env` file found from the
  working directory upward, then the config file.
- Tools run without permission prompts; Bub has no permission modes.

`bub acp` comes from the `bub-acp-server` plugin. It serves ACP v1 over
stdio for one client connection and keeps an index of its sessions in
`$BUB_HOME/acp-sessions.json`; each session's history is a tape named
after its session id and working directory. OAR uses this server.

## High-level mapping to OAR

| Native concept or owner | Current OAR mapping |
| --- | --- |
| `BUB_HOME`, model, keys | `SessionOptions.env` (`BUB_HOME`, `BUB_MODEL`, `BUB_<PROVIDER>_API_KEY`, ...), or the environment OAR runs in. OAR writes nothing of its own there. |
| `bub acp` process | The session's process; ending it detaches the session. |
| Session | `Session.id` is the ACP session id; `resume` is ACP `session/resume`, confirmed against `session/list` first. |
| Prompt | One ACP `session/prompt`, one turn. |
| Model | `SessionOptions.model` through the `model` config option, confirmed by the answer. |
| Effort | `SessionOptions.effort` through the `reasoning_effort` config option (category `thought_level`). |
| Usage | The prompt answer's `usage` (input and output tokens of the turn); context usage from `usage_update`. |
| Subagents | `capabilities.attribution: "opaque"`: subagent events are Lody extensions this adapter does not read. |

`capabilities` are `{ queue: { durable: false }, attribution: "opaque" }`;
images follow the server's advertised prompt capabilities (accepted). The
session has no `steer` and no task stop.

## Capability details

### Open, resume and dispose

`session()` checks the declared refusals, then runs the shared ACP opening:
`initialize`, `session/new` (or `session/resume`) and the model and effort
settings. `session/new` and `session/resume` ask the provider for its model
list, so the open's request timeout is 30 seconds.

Bub accepts a resume of any id in any cwd. The tape is named after both, so
a resume of an unknown id, or of a known one in another directory, would
open an empty history, and Bub would rewrite its index to match. The profile
sets `resumeKeepsSessionCwd`: before resuming, OAR reads `session/list` and
refuses (`ResumeCwdError`) an id that is not listed or a cwd other than the
listed one. A listed session resumed in its own cwd keeps its history, model
and effort.

Bub advertises `session/close`, but it removes the session from the index
(the tape stays), after which a resume could not be confirmed. The profile
sets `detachOnDispose`, so `dispose()` ends the `bub acp` process without it
and the session stays listed.

### Prompt, queue and abort

Bub queues a prompt sent during a turn and answers it after that turn, but
input given during a turn is held by OAR and sent when the turn ends
(`queue.durable: false`). `abort` is ACP `session/cancel`; the turn ends
with stop reason `cancelled` within tens of milliseconds, also during a
shell tool call, and the next turn works.

Bub steers with a Lody extension, `_lody/session/steer`. Its answer waits
until the running step ends (a long tool call keeps it pending), and with no
turn running it starts a new turn instead, so OAR does not map it to
`steer`.

### Models and effort

The `model` option lists `BUB_MODEL`, its fallbacks and what the provider's
model listing returns, as `provider:model` ids. An id it does not list is
refused by Bub and surfaces as `model_unavailable`. The `reasoning_effort`
levels are `auto` (the default), `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max` and `ultra`; Bub passes the level to the provider,
whose support depends on the model. Both settings are stored with the
session. `listModels` is unsupported: Bub has no model listing outside a
session's config options.

### Session MCP servers

OAR accepts credential-free stdio and HTTP entries; `bub acp` advertises
HTTP and SSE as well as stdio and binds the entries to that session only,
in memory. Entries with `env` or `headers` are refused
(`mcpServerCredentials`) because their isolation is unverified. Bub
exposes each MCP tool as `mcp_<server>_<tool>` behind its deferred tool
loading, so the model may look the tool up before calling it.

### Authentication and environment

OAR has no login or account usage for Bub. A key reaches Bub through the
environment: `SessionOptions.env`, the environment OAR runs in, a `.env`
file in or above the session's cwd, or Bub's config file. `bub onboard` and
`bub login` set them up interactively.

Bub answers every failure as `-32603 Internal error` with its words in
`data.details`. A provider's HTTP error reads `Provider returned HTTP
<status>: <body>`; OAR reports the status and classifies the turn by the
body's error code, else by the status. A 401 is always `auth` (DeepSeek
names a bad key `invalid_request_error`); it cannot tell a missing key from
a refused one, so `credential` is not set.

### Installation

`bub` on `PATH` (or `OAR_BUB_BIN`) whose `bub acp --help` describes the ACP
server: a Bub without the `bub-acp-server` plugin is not usable. `oar
install bub` runs `curl -fsSL https://bub.build/install.sh | bash -s --
--preset acp`, which installs uv when none is on PATH, creates
`~/.bub/.venv`, links `~/.local/bin/bub` and installs the `acp` preset's
plugins without prompting. An existing Bub gets the plugin with
`bub install bub-acp-server@main`.

## Known gaps

- **Refused options**: the list and each reason are in
  [options.ts](../../packages/oar/src/community/bub/options.ts).
  `launchArgs` are refused: `bub acp` takes only transport and protocol
  flags.
- **Overlapping sessions on one `BUB_HOME`** can lose index entries: each
  `bub acp` process writes its own copy of the index on every prompt, so a
  session opened by another process after this one started is dropped from
  it. OAR then refuses that session's resume (its tape is intact). Give
  concurrent sessions their own `BUB_HOME` when they must stay resumable.
- **Context window**: when the provider reports none, `usage_update` names
  `BUB_ACP_SERVER_CONTEXT_WINDOW_SIZE` (default 128000), not the model's
  real window.
- **No steer, login, account usage, model listing, update check, compaction
  or session listing** through OAR.
- **No CI job**: no CI runner installs `bub`; the behavior suite is a local
  run.

## Evidence and verification

- `experiments/bub-acp-probe.ts`, 2026-11-27, against aimock; findings in
  the script's `OBSERVED` header.
- Shared behavior suite: `OAR_TEST=bub-aimock pnpm sea-trial` (a fresh
  `BUB_HOME` with Bub's `openai` provider pointed at aimock, needs `bub`
  installed), 2026-11-27, three runs: 16 passed, 4 skipped for capabilities
  Bub does not have (account usage, steer twice, model listing).
- DeepSeek's API with a real key (`deepseek:deepseek-flash`), 2026-11-27:
  - `oar run bub`: a shell-tool turn writing a file, then a resume with
    `--model deepseek:deepseek-v4-pro --effort high` that recalled the first
    turn; a resume from another cwd and of an unknown id refused, an
    unlisted model refused as `model_unavailable`, an unlisted effort
    refused, a wrong and a missing key ending the turn as `auth` with
    status 401.
  - The library: abort during a 30-second shell command (the turn ended
    `aborted`, the next one completed, no process left), token and context
    usage after the turn, an image read correctly, and a stdio and an HTTP
    echo MCP server (`sea-trial/vendor/support/echo-mcp.ts`) in one
    session's `mcpServers`, both tools called, no server process left.
  - Two sessions on one `BUB_HOME`, the second opened before the first's
    prompt: the second dropped from the index and its resume refused.
- Unit tests: [session](../../tests/community/bub/bub-session.test.ts) for
  the version reader, the install line, the `launchArgs` refusal, provider
  failures, the model refusal and confirmation, the resume and dispose rule
  and the brand.
