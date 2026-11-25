# Hermes

`hermes acp` (also published as `hermes-acp`) over stdio: a **viewer** of the
Hermes gateway daemon, protocol 1. The daemon owns turns, tools, provider
credentials, MCP attachment and persistence; the ACP process relays them. The
adapter lives in
[`packages/oar/src/runtimes/hermes/`](../../packages/oar/src/runtimes/hermes/)
and reuses the shared ACP v1 profile.

Facts below were observed on `hermes 0.23.3+1139.g084538c` (macOS arm64,
2026-11-24) from the checkout's `hermes-acp` entry, with the optional
`agent-client-protocol==0.9.0` extra installed. The repeatable probe starts a
scripted OpenAI-compatible provider in a temporary `HERMES_HOME`; no login,
account or real model is used
([probe](../../experiments/hermes-acp/README.md)).

## What Hermes owns

- **Gateway session** — created by `session/new`, addressed by the ACP
  `sessionId`, and persisted by the daemon. The ACP process can be replaced or
  killed while the daemon keeps the conversation.
- **Turn / admission** — a prompt is submitted to the daemon and settles when
  its admission completes. The ACP `session/prompt` answer carries the turn's
  `stopReason`; the text, thought, tool and usage updates arrive as standard
  `session/update` notifications.
- **Profile** — provider/model selection, API keys and OAuth credentials live
  in `$HERMES_HOME` (`config.yaml`, `.env`, `auth.json`), not in the ACP
  handshake.
- **Editor MCP servers** — `session/new` and `session/resume` carry them; the
  daemon freezes the tool list per session and keeps an entry's `env` values in
  its own memory ([session MCP servers](#session-mcp-servers)).

## OAR mapping

| Hermes ACP surface | OAR contract |
|---|---|
| `initialize` | Records the handshake. Advertises protocol 1, image prompts, `loadSession`, `session/fork`, `session/list` and `session/resume`. No `session/close`. |
| `session/new` | `session()`; the reply's `models`, `configOptions` and `modes` become `model` / `effort` events and opening records. |
| `session/resume` / `session/load` | `SessionOptions.resume`; the gateway moves the session to the requested `cwd`. Missing ids answer the gateway's `not_found` reason, mapped to `SessionNotFoundError`. |
| `session/fork` | `SessionOptions.fork` without `through`; the gateway copies the whole conversation under a new id. |
| `session/prompt` | `prompt()`; `stopReason` decides the turn outcome, and the standard update stream supplies text, reasoning, tool calls and context usage. |
| `session/cancel` | `abort()`; the admission is cancelled and the prompt answers `cancelled`. |
| `session/set_config_option` on `model` | `SessionOptions.model`; the returned full option list is the applied-model readback. |
| `session/set_config_option` on `reasoning_effort` | `SessionOptions.effort`; the returned list reports the applied level. |
| `session/list` | Not used for resume; the gateway resumes by id and reports a missing target itself. |
| stdio `mcpServers` | `SessionOptions.mcpServers`, sent on every open. HTTP is refused because `initialize` advertises no `mcpCapabilities.http`. A stdio entry with `env` attaches on 0.23.3 (the release OAR measured) and is refused with `mcpServerCredentials` on every other release ([session MCP servers](#session-mcp-servers)). |
| `available_commands_update`, `config_option_update`, `session_info_update` | Recorded verbatim. Config updates also produce `model` / `effort` events. |

`Session.capabilities` reports an adapter-held queue (`durable: false`),
`attribution: "opaque"`, and images from the handshake. `Session.steer` is
absent: a second prompt is not verified to redirect the active turn, so queued
input is held by OAR instead. `Session.stopTask` is absent. Manual compaction
is declared unsupported: `/compress` is advertised, but there is no structured
completion or attribution contract.

## Session MCP servers

`SessionOptions.mcpServers` reaches the gateway as ACP's `mcpServers` param on
`session/new`, `session/resume`, `session/load` and `session/fork`, and the
daemon turns each stdio entry into a toolset for that session only. OAR sends
the whole list again on every open, because the daemon's rule is that a viewer
resupplies the exact transport specification: an empty or omitted list keeps
the session's servers, and a different list re-binds them.

An entry's `env` **is a credential, and OAR supports it on one release**:

- **Verified: `0.23.3`** (`0.23.3+1139.g084538c`). The values are given to the
  daemon, which starts the entry's command with them and keeps them in the
  owner's own memory (`gateway/session_local_mcp.py`: the session-scoped
  `_local_editor_mcp` borrow, dropped when the last borrower and viewer leave).
  What the daemon persists is `editor_mcp_json`: a scope, the list's SHA-256
  fingerprint, the frozen tool schemas and the derived server names — never an
  `env` or `header` value. A session reopened with a new generation of values
  re-spawns the server, which is how a resumed conversation runs on the
  current credentials instead of the ones the previous viewer supplied.
- **Refused everywhere else.** An older, newer or unreadable release declares
  `mcpServerCredentials` in `sessionCapabilities(installation)` and rejects the
  open with `UnsupportedOptionError` on `mcpServers` before anything starts.
  Both the declaration and the open read `hermesInstallationRefusals`
  ([mcp-credentials.ts](../../packages/oar/src/runtimes/hermes/mcp-credentials.ts)),
  so a host is never told an entry attaches and then refused. `hermes
  --version` prints the numeric release only, and a build with other metadata
  is the same release; a prerelease of it is not.

**Transports**: stdio only. `hermes` advertises no
`mcpCapabilities.http`, so ACP's own capability rule refuses an HTTP entry at
the open, credentials or not.

**What OAR does with the values**: they are registered with the session's
credential rules, so `records()`, the query folds, errors and `dispose()`
report them as `[redacted]` — including when the daemon echoes them back in a
tool result, a turn's text or a refusal message. OAR never writes them to
disk, and the native store keeps only the fingerprint above.

**What is the runtime's own**: Hermes persists the conversation, so a tool
result that itself contains a value is transcript text like any other tool
output, stored in the daemon's `state.db` and outside OAR's redaction. A host
that must keep a value out of native storage has to keep it out of tool
output; OAR's guarantee covers the entry's `env` values, not what a tool
chooses to print.

### Token usage

The gateway's `PromptResponse.usage` is the daemon's **session-cumulative**
counter (`gateway_session_meta.turn_usage` over `usage_stats`), not one
prompt's spend. OAR does not map it as per-prompt tokens, so `usage().total`
stays `null` rather than double-counting a session total on every turn. Context
occupancy still arrives through `usage_update` and is reported by
`contextUsage()`.

## Authentication and credentials

Hermes authenticates through its own profile: API keys in
`$HERMES_HOME/.env`, OAuth/account credentials in `auth.json`, and the selected
provider/model in `config.yaml`. The adapter declares those stores and common
provider env variables for hosts that fill them, but implements no `login`,
`logout` or `authStatus`: `hermes auth` and `hermes model` are interactive or
provider-specific, and the ACP `authenticate` methods only acknowledge an
already-configured provider.

`SessionOptions.env` reaches the ACP viewer and any gateway daemon it starts.
An already-running daemon keeps its own environment; a host isolating two
sessions should give each its own `HERMES_HOME` (and therefore its own daemon).

## Installation

The official installer is
`curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`
(macOS/Linux; Windows has a PowerShell command OAR does not run). It installs
the checkout under `$HERMES_HOME/hermes-agent` and publishes
`~/.local/bin/hermes`.

The ACP entry is an optional extra and is **not** installed by the bootstrap:

```sh
hermes pm install --extra acp
```

OAR's installation probe runs `hermes acp --check`, which verifies that extra
and the adapter imports, then reads `hermes --version`. A Hermes without the
extra reports `unsupported` / `readiness_failed` instead of failing every
session open. Install, upgrade and account-usage members are not implemented
yet; the runtime page records those gaps rather than guessing at them.

## Not implemented

`install`, `installPlan`, `checkUpdate`, `upgrade`, `accountUsage`, `login`,
`logout`, `authStatus`, and the skills/commands/MCP-server/tool inventories
are absent. Hermes' own commands (`hermes update --check`, `hermes usage
--json`, `hermes skills list`) exist, but their output contracts have not been
verified against OAR's typed results, and the ACP handshake carries no
inventory channel. The official bootstrap does not install the `acp` extra,
so OAR's installation probe reports what the native `acp --check` says rather
than pretending a partial install is ready.

## Side effects of reading

`listModels` opens a real gateway session and reads its `models` / `configOptions` picker. Hermes advertises no `session/close`, so the gateway retains that unprompted session after OAR kills the ACP viewer. `installation()` runs `hermes acp --check`, which imports the adapter and performs the normal Hermes profile/plugin discovery but starts no server. Neither path makes a model request.

## Failures

ACP `-32000` maps to `auth` as for every ACP runtime (`RuntimeFailureError`
at open or model selection, a failed turn on `session/prompt`). A missing
resume target is the gateway's `not_found` reason on an internal-error reply
(`-32603`, `data.details: "not_found"`), mapped to `SessionNotFoundError`;
the ACP transport's own message is generic ("Internal error"), so the typed
error carries the native cause. Other gateway refusal reasons are classified
from their words by the shared ACP failure rules; none has been measured with
a live provider yet.

## Verification

- Unit/vendor-shaped fixture: [`tests/hermes/hermes-session.test.ts`](../../tests/hermes/hermes-session.test.ts)
  and [`tests/fixtures/fake-acp-hermes.mjs`](../../tests/fixtures/fake-acp-hermes.mjs)
  pin the recorded handshake, session fields, config-selector model/effort
  readback, `not_found` resume mapping, model listing and installation probe.
- Session MCP credentials: [`tests/hermes/hermes-mcp-credentials.test.ts`](../../tests/hermes/hermes-mcp-credentials.test.ts)
  drives the runtime entry through a gateway-shaped fixture
  ([`fake-acp-hermes.mjs`](../../tests/fixtures/fake-acp-hermes.mjs) plus
  [`fake-hermes-editor-mcp.mjs`](../../tests/fixtures/fake-hermes-editor-mcp.mjs))
  and a real MCP stdio server ([`mcp-probe-server.mjs`](../../tests/fixtures/mcp-probe-server.mjs)):
  the release gate on both sides of the declaration, the entry's `env`
  reaching the tool process, `tools/list` and `tools/call`, a resumed session
  running on the new generation, `[redacted]` in the records, a failed open
  that quotes the value, an HTTP entry still refused, and a store that holds a
  fingerprint only. No real key is used anywhere.
- Real runtime: the [probe](../../experiments/hermes-acp/README.md) runs the
  real `hermes acp` with a scripted provider. Observed: installation
  `0.23.3`, image capability true, model `custom:oar-fake-model`, effort
  `default`, one completed turn with the scripted text, context usage
  `{ tokens: 0, contextWindow: 256000 }` from the daemon's stats, and
  `SessionNotFoundError` for a missing resume id.
- Real runtime, session MCP credentials:
  [`mcp-credentials-probe.ts`](../../experiments/hermes-acp/mcp-credentials-probe.ts)
  runs the same entry against the real daemon. Observed on
  `hermes 0.23.3+1139.g084538c` (macOS arm64): the daemon starts the entry with
  its `env`, the tool process answers `tools/list` and a `tools/call` the
  model asked for (the tool is offered as
  `mcp__editor_probe_<tag>__probe_echo`), a resumed session starts it again
  under the second generation's values, OAR's records hold neither value, and
  no file under the temporary `HERMES_HOME` holds the value after a turn in
  which the tool did not echo it. The one file that does after an echoing turn
  is the daemon's `state.db` transcript — tool output, not the credential.

Still open: a real logged-in provider turn with a non-zero context,
child/subagent attribution, steer, account usage and the Windows entry point.
The probe output is a scripted-provider observation, not a claim about any
particular model or account.
