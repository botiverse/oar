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

## Not established

A logged-in provider turn with tool calls, a non-zero context, subagent
attribution, native steering, session MCP execution, account usage and the
Windows entry point. The scripted provider is evidence about the ACP mapping,
not a claim about any model or account.
