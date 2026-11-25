# Hermes ACP first contact

**Question:** is the shipped `hermes-acp` entry an ACP v1 agent OAR can drive
through its generic ACP profile, and which session semantics does the gateway
viewer expose?

**Answer (2026-11-24):** yes. `hermes 0.23.3+1139.g084538c` (macOS arm64)
answers `initialize` with protocol `1`, `loadSession`, image prompts,
`session/fork`, `session/list` and `session/resume`. The ACP process is a
viewer of the Hermes gateway daemon; one real `session/new` → `session/prompt`
cycle completed through OAR with a scripted OpenAI-compatible provider.

## Reproduction

The entry needs Hermes' optional ACP dependency:

```sh
hermes pm install --extra acp
```

Then, from the OAR checkout:

```sh
OAR_HERMES_BIN=/absolute/path/to/hermes \
  pnpm tsx experiments/hermes-acp/probe.ts
```

If the `acp` package is on a wheel path rather than installed in that
interpreter, also set `OAR_HERMES_PYTHONPATH=/absolute/path/to/acp/wheel`.
The probe starts a local OpenAI-compatible provider on an ephemeral port,
writes a temporary `HERMES_HOME` whose `config.yaml` points at it, opens the
real `hermes acp`, makes one prompt, tries a missing resume, stops the
gateway and removes the home. It uses no login, account or real model.

## Selected output (redacted)

```json
{
  "installation": {
    "kind": "available",
    "via": "executable",
    "version": "0.23.3"
  },
  "capabilities": {
    "queue": { "durable": false },
    "attribution": "opaque",
    "images": true
  },
  "model": "custom:oar-fake-model",
  "effort": "default",
  "turn": {
    "kind": "ended",
    "outcome": { "kind": "completed" }
  },
  "text": "hello from the OAR fake provider",
  "contextUsage": { "tokens": 0, "contextWindow": 256000, "percent": 0 },
  "tokenTotal": null,
  "records": [
    "request:open",
    "response:opened",
    "initialize",
    "session/new:model,effort",
    "request:prompt",
    "response:accepted",
    "available_commands_update",
    "session_info_update",
    "config_option_update:model,effort",
    "agent_message_chunk:text_delta",
    "usage_update:usage",
    "session_info_update",
    "config_option_update:model,effort",
    "config_option_update:model,effort",
    "session/prompt:turn_ended"
  ],
  "missingResume": {
    "name": "SessionNotFoundError",
    "message": "Internal error"
  }
}
```

Session ids, the executable path, the temporary home and the provider port are
removed. The context tokens are `0` because the scripted provider reports no
usage; the window (`256000`) is Hermes' configured default.

## What this establishes

- The standard ACP handshake and session replies are enough for OAR's generic
  profile: opens, one completed turn, text streaming and a usage update all
  map without a vendor-specific projection.
- The gateway advertises `model` and `reasoning_effort` as select
  `configOptions`; `session/set_config_option` answers the full list with the
  applied value, which is why the adapter sets `modelViaConfigOption`.
- A missing `session/resume` target reaches OAR as the gateway's `not_found`
  reason and becomes `SessionNotFoundError` (the native message is the ACP
  transport's `Internal error`; the typed error carries the method and native
  detail).
- The prompt reply's `usage` is the daemon's session-cumulative counter, so
  OAR deliberately leaves `usage().total` `null` rather than mapping it as
  one turn's spend.

## Session MCP credentials (`mcp-credentials-probe.ts`)

**Question:** when a session attaches a stdio MCP entry whose `env` carries a
value, does the real daemon give that value to the tool process, does a resumed
session run on the current generation of values, and does anything persist it?

**Answer (2026-11-25), `hermes 0.23.3+1139.g084538c` on macOS arm64:** yes to
all three, and no value is persisted. The daemon starts the entry with its
`env`, the tool process answers `tools/list` and a `tools/call` the model asks
for, a viewer that resumes the conversation with a new list re-spawns the
server under the new values, and the only thing the store keeps is the list's
fingerprint, the frozen schemas and the derived names
(`gateway/session_local_mcp.py`).

```sh
OAR_HERMES_BIN=/absolute/path/to/hermes \
  pnpm tsx experiments/hermes-acp/mcp-credentials-probe.ts
```

The probe writes a temporary `HERMES_HOME` pointing at
[`tool-calling-provider.ts`](tool-calling-provider.ts), a scripted
OpenAI-compatible provider that asks for one tool call, and attaches
[`mcp-probe-server.mjs`](../../tests/fixtures/mcp-probe-server.mjs) as the
session's stdio entry. The two token values are synthetic — the only ones the
run uses — and the output names files, never their text. A source checkout has
no `.git` or install stamp, so `hermes --version` says `vunknown` there; write
the release into the checkout's stamp first
(`python scripts/write_install_stamp.py --output install-stamp.json
--base-version 0.23.3 --distance 0 --update-mechanism self --source local
--commit <40 hex characters>`).

Selected output (redacted: the two synthetic values are shown as their
generation names):

```json
{
  "installation": { "kind": "available", "via": "executable", "version": "0.23.3" },
  "toolProcessStarts": ["<generation-one>", "<generation-one>", "<generation-two>"],
  "eachGenerationRanTheToolProcess": true,
  "mcpEvents": ["start", "initialize", "tools/list", "start", "initialize", "tools/list",
                "tools/list", "tools/call", "start", "initialize", "tools/list",
                "tools/list", "tools/call"],
  "toolsOfferedToTheModel": [["mcp__editor_probe_160b0dad__probe_echo"], ["mcp__editor_probe_160b0dad__probe_echo"],
                             [], ["mcp__editor_probe_160b0dad__probe_echo"],
                             ["mcp__editor_probe_160b0dad__probe_echo"], []],
  "toolArguments": ["hello", "hello"],
  "credentialInOarRecords": { "generationOne": false, "generationTwo": false },
  "credentialPersistedAfterATurnTheToolDidNotEcho": [],
  "filesHoldingTheValueAfterTheToolEchoedIt": ["state.db"],
  "homeFiles": 365
}
```

## What the credential probe establishes

- The daemon spawns the editor's stdio entry with the entry's own `env`
  (`toolProcessStarts`), performs one eager `tools/list`, and executes a
  `tools/call` the model asked for.
- A resumed session re-spawns that server, so the tool process runs under the
  values the resuming viewer supplied, not the previous generation's.
- OAR's records carry neither value (`credentialInOarRecords`), including the
  tool result the daemon streamed back.
- After a turn in which the tool answered without echoing the value, no file
  under `HERMES_HOME` holds it: the daemon keeps the values in the owner's
  memory and its store keeps a fingerprint.
- The one file that does hold a value after an echoing turn is the daemon's
  own transcript (`state.db`) — tool output, stored like any other and outside
  OAR's redaction. The probe separates the two turns for that reason.

## Not established

A logged-in provider turn with a non-zero context, subagent attribution,
native steering, account usage and the Windows entry point. The tool call here
is driven by a scripted provider that answers the gateway's native `tools`
array; the profile keeps `tools.tool_search` off so the MCP tool is offered
directly instead of behind that bridge. The scripted provider is evidence
about the ACP and MCP plumbing, not a claim about any model or account.
