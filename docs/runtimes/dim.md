# Dim

**Community runtime**, maintained by [@wey-gu](https://github.com/wey-gu).
Verified against the real `dima` binary with a scripted model provider (the
shared behavior suite and a raw ACP probe) and with DeepSeek's own API
through both bring-your-own-key paths, 2026-11-26; not yet against a Dim
account or another managed provider's login.

It lives in `packages/oar/src/community/dim/` and is exported from
`@botiverse/oar/community`, not `defaultRuntimes`; a host adds it with
`createRuntimeRegistry([...defaultRuntimes.list(), createDimRuntime()])`.
The `oar` CLI includes it. The scripted unit tests are in
`tests/community/dim/`; set `OAR_COMMUNITY_TESTS=1` to include them in a
local unit run.

Evidence baseline: `dima` from the npm package `dimcode-alpha`,
`dimcode 0.1.0-alpha.29`, and native source
[`arcships/dim`](https://github.com/arcships/dim) at `30421b40`
(its ACP gateway design, `docs/design/acp-gateway-implementation.md`, and
`crates/dim-acp`). Live observations come from
[`experiments/dim-acp-probe.ts`](../../experiments/dim-acp-probe.ts)
([evidence](#evidence-and-verification)). Versions are evidence baselines,
not a support range.

## Native concepts and calling interfaces

Dim is a Rust coding agent with a terminal UI (`dima`), one-shot runs
(`dima -p`), a desktop app and an ACP gateway. Its state lives in a **home**
(`--home`, default `~/.dimcode-alpha` for the alpha build): settings, the
provider catalog and accounts, sessions and their history in one SQLite
database.

- The **App Server** (`dimcode-server`) is a per-home daemon. Every client of
  a home (the TUI, `dima -p`, `dima acp`) connects to the
  same one over a Unix socket in `<home>/rust/`; the first client that finds
  none starts it, and it stays running after that client exits
  (`dima daemon stop --home` ends it).
- A **session** is one persistent conversation with its own cwd, model and
  permission mode; any client of the home can resume it.
- A **model** comes from the home's provider catalog (managed providers with
  a Dim or vendor login, or custom OpenAI-compatible providers added in the
  TUI with `/connect`), or from a `--model-config` JSON file that names the
  providers and models directly and bypasses the catalog.
- The **permission mode** is `read-only`, `workspace-write` (the default) or
  `full-access`.

`dima acp` serves ACP v1 over stdio for one client connection and relays it
to the home's App Server. It takes `--home`, `--server`, `--model-config`
and `--agent`, and refuses `--model`, `--effort` and `--permission`. OAR uses
this gateway.

## High-level mapping to OAR

| Native concept or owner | Current OAR mapping |
| --- | --- |
| Home | Chosen by `launchArgs` (`--home`, `--server`, `--model-config`); otherwise Dim's default home. OAR adds nothing of its own to it. |
| App Server | Not the session's process. Before `dima acp` starts, the adapter runs `dima runtime list` with the same home selection, which starts the App Server if none runs; it then outlives that command and every OAR session ([daemon.ts](../../packages/oar/src/community/dim/daemon.ts)). |
| `dima acp` process | The session's process; ending it detaches the session. |
| Session | `Session.id` is Dim's session id; `resume` is ACP `session/resume`. |
| Prompt | One ACP `session/prompt`, one turn. |
| Permission mode | `full-access`, set with `session/set_mode` after open. |
| Model | `SessionOptions.model` through the `model` config option (catalog homes only), confirmed by the `config_option_update` Dim pushes. |
| Effort | `SessionOptions.effort` through the `thought_level` config option (id `effort`), which exists only for a catalog model that declares reasoning; confirmed the same way. |
| Context usage | Dim's `usage_update` (estimated input tokens and the context window), which it pushes right after each prompt's answer; the profile waits for it (`usageUpdateAfterPrompt`). |
| Subagents | `capabilities.attribution: "opaque"`: the gateway serves the root session only. |

`capabilities` are `{ queue: { durable: false }, attribution: "opaque" }`;
images follow the gateway's advertised prompt capabilities (accepted in
alpha.29). The session has no `steer` and no task stop.

## Capability details

### Open, resume and dispose

`session()` checks the declared refusals and `launchArgs`, starts the App
Server if needed, then runs the shared ACP opening: `initialize`,
`session/new` (or `session/resume` with the session's cwd), the model and
effort settings, and `full-access`.

Dim checks a resume's cwd itself: another cwd is refused natively with
`-32001 session_invalid_input` ("Session cwd does not match expectedCwd").
Only `-32002` ("Resource not found") reads as a missing session.

Dim advertises `session/close`, but it ends the saved session for every
client, after which a resume answers `-32002`. The profile sets
`detachOnDispose`, so `dispose()` ends the `dima acp` process without it and
the session stays resumable.

### Prompt, queue and abort

Dim refuses a prompt while one runs (`-32001 session_busy`), so input given
during a turn is held by OAR and sent when the turn ends
(`queue.durable: false`). `abort` is ACP `session/cancel`; the turn ends with
stop reason `cancelled`.

### Models and effort

A `model` config option exists only when the session's model comes from the
home's provider catalog. With `--model-config` there is none, and a `model`
request is refused before any request is sent. An id the option does not
list is refused by Dim (`Invalid params`) and surfaces as
`model_unavailable`. Effort is refused when the model publishes no
`thought_level` option, and a level the option does not list is refused by
Dim. With DeepSeek's catalog the effort levels are `provider-default`,
`none`, `low`, `high` and `max`; a `--model-config` file never has the
option. `listModels` is unsupported: Dim has no model listing outside a
session's config options.

Dim pushes every applied setting as `config_option_update`, and right after
a model switch it answers an effort change with the previous level, pushing
the applied one about a millisecond later. The profile therefore sets
`confirmConfigOptionUpdates`: each setting waits for its notification, and
an answer that still shows the previous value is read through the
notification that confirmed the new one.

### Authentication and environment

OAR has no login or account usage for Dim; sign in with `dima` itself
(`/login`, or `/connect` in the TUI for an API key). An ACP `auth_required`
error (`-32000`, a managed provider without an account) is an `auth`
failure.

A key can come from either side of the bring-your-own-key choice:

- **Dim's catalog**: `/connect` in the TUI stores the key in the home (for
  DeepSeek, the built-in `deepseek` provider). Sessions on that home need no
  environment, and they get the `model` and effort options.
- **`--model-config`**: the file names the provider (for DeepSeek, `kind:
  "openai-compatible"` with `compatible.preset: "deepseek"`) and an
  `apiKeyEnv` variable; pass the file with `launchArgs` and the key in
  `SessionOptions.env`.

A turn Dim stops for its credential is an `auth` failure that says which:
`credential: "missing"` for "Missing credential environment variable",
`credential: "rejected"` for "The provider rejected the credentials". An
App Server that cannot start (an invalid model config, for example) fails
the open with the last line of its log.

`SessionOptions.env` reaches `dima acp` and the `dima runtime list` call
that may start the App Server. Provider keys a model config reads
(`apiKeyEnv`) are read by the App Server, so they apply only when that
session starts it; an App Server already running keeps the environment it
started with.

### Installation

`dima` on `PATH` (or `OAR_DIM_BIN`), else the nightly's `dim-nightly` or
`dimn`. The `dim` and `dimcode` commands of the earlier `dimcode` npm package
are a different CLI and are not candidates. `oar install dim` runs
`npm install -g dimcode-alpha`.

## Known gaps

- **Refused options**: `fork`, `systemPrompt`, `appendSystemPrompt`,
  `additionalDirectories`, `disallowedTools`, `outputSchema`, `serviceTier`,
  `name`, `goals`, `userConfiguration`, `nativePermissions`,
  `userQuestions`, `modelRequests`, `mcpServerCredentials` and
  `endTurnProcessesOnAbort` (reasons in
  [options.ts](../../packages/oar/src/community/dim/options.ts)).
- **No steer, login, account usage, model listing, update check, compaction
  or session listing** through OAR, although the gateway advertises `session/list`,
  `session/fork` and `session/delete`.
- **App Server lifetime**: OAR never stops an App Server; one started by a
  session keeps running until `dima daemon stop --home` or a reboot.
- **No CI job**: no CI runner installs `dima`; the behavior suite is a local
  run.

## Evidence and verification

- `experiments/dim-acp-probe.ts`, 2026-11-26, dimcode 0.1.0-alpha.29: once
  with a `--model-config` file and once on a catalog home with a custom
  provider, both against a local aimock provider; findings in the script's
  `OBSERVED` header.
- Shared behavior suite: `OAR_TEST=dim-aimock pnpm sea-trial` (a
  `--model-config` home over aimock, needs `dima` installed), 2026-11-26:
  16 passed, 4 skipped for capabilities Dim does not have (account usage,
  steer twice, model listing).
- `oar run dim` on a catalog home over aimock: a default-model turn, a turn
  on a switched catalog model, an unlisted model refused as
  `model_unavailable`, effort refused without a `thought_level` option.
- DeepSeek's API with a real key, 2026-11-26:
  - `--model-config` (`deepseek-flash`): a shell-tool turn, recall in the
    next turn, abort during a tool call, resume with its history, context
    usage current at each turn's end, model and effort refused, and a wrong
    or missing key ending the turn as `auth` with `rejected` or `missing`.
  - A catalog home after TUI `/connect`: the default model and effort read
    back, a read-tool turn with reasoning, `deepseek-v4-pro` with `low`
    across a resume, `deepseek-flash` with `max`, an unlisted level and an
    unknown model refused, and `oar run --model deepseek-v4-pro --effort
    max` writing a file with Dim's `write` tool, then resumed.
  - Images: a logging proxy showed the image reaching DeepSeek byte for
    byte; DeepSeek reads a real picture correctly through Dim. It misreads
    a tiny solid-color test image only behind Dim's long system prompt, the
    same way when that request is replayed without Dim.
- Unit tests: [session](../../tests/community/dim/dim-session.test.ts) for
  the version reader, `launchArgs` checks, App Server selection, mode and
  model handling, credential failures, the App Server log reading and the
  resume rule; the shared
  [detach test](../../tests/acp/acp-detach-on-dispose.test.ts) for
  `detachOnDispose`, and the shared
  [config confirmation tests](../../tests/acp/config-updates.test.ts) with
  the antigravity fixture's stale-answer case.
