# Bottega

`bottega serve` over stdio, one process per session: JSON lines in and out,
each command answered once, every other line something that happened. Facts
below were measured on bottega 0.3.0 (`@botiverse/bottega`, macOS arm64,
2026-11-28) against a scripted provider in a temporary home
(`sea-trial/harness/bottega-aimock.ts`). The adapter in
[`packages/oar/src/runtimes/bottega/`](../../packages/oar/src/runtimes/bottega/)
is the reference for what OAR does; its declarations
([`refusedSessionOptions`](../../packages/oar/src/runtimes/bottega/options.ts)
with a reason for each, `sessionCapabilities`, the members present) are the
list of what is supported. This page keeps what the code cannot say: how
bottega behaves, and why OAR maps it this way.

## Native concepts

Bottega keeps an agent's state in apps, not in its context. The context is a
screen of the apps' windows: between rebuilds each step appends what changed
to a record of what was done and said, and the screen is drawn whole again
from the apps when that is cheaper, when the context is nearly full, or when
the provider's cache has gone cold. No model call compacts it. Three of its
ideas shape the mapping:

- A **session** is a directory under bottega's home (`BOTTEGA_HOME`, default
  `~/.bottega`), keyed by the working directory and its id. It holds the
  windows, the conversation and a record of every step, and can be taken up
  again.
- The agent **speaks by acting**: a reply is a post into the conversation
  app. Text a model writes without sending reaches nobody, and a turn ends
  when a step calls nothing.
- The world reaches a session through its **inbox**: an event wakes the
  session and leaves one pointer line on the screen; what there is to read
  stays in the app that holds it.

## Where bottega differs from the contract

- **Origin changes what an input is.** An input with `origin.kind`
  `notification` or `automation` is sent with its origin and becomes an event
  signed by `origin.source`, not a line of the conversation, so no
  `user_message` follows. Every other runtime receives the text alone
  ([conversation](../spec/conversation.md)).
- **An event can turn an app on.** When `origin.source` names one of
  bottega's installed apps that the session lacks, bottega turns it on and
  reads the event there (a `note` says so). Raft's daemon signs its wakes
  `raft`: bottega's Raft app then lists what waits through the `raft` command,
  so the session's environment needs that command, logged in.
- **Bottega may decline an event.** After an `abort`, or a failed turn, it
  starts no turn for an event until an input with `origin.kind: "user"`
  arrives. The declined input comes back as `input_dropped`
  (`runtime_refused`, with bottega's reason) and the session is idle again.
  Under `serve`, how many events in a row may start turns is the host's rule;
  bottega's desktop has its own bound.
- **A steer can start the next turn.** A steer put into a turn that is aborted
  before its next step starts the turn after: the stream shows the abort's
  `turn_ended`, then `turn_active` naming the steer's `inputId`.
- **A saved session keeps its route.** `model` is `provider/model`, the model
  id keeping its own slashes (`openrouter/deepseek/deepseek-v4.1-flash`). A
  resume that asks for another route is refused; one that asks for another
  listed `effort` applies it and keeps it.
- **Effort is per model.** `listModels` gives each model's levels in bottega's
  spelling (`off` to `max`), and bottega refuses a level the model cannot run
  (`unsupported_thinking`) rather than run another.
- **Actions report no result.** An action is `tool_call_started` and
  `tool_call_ended` in one frame, with bottega's note as text content.

## Installation, models and credentials

OAR runs the `@botiverse/bottega` package it carries as an optional
dependency (`via: "bundled"`, under the host's Node), or, in a single-file or
Electron host or where the package is absent, an installed `bottega` at or
above `BOTTEGA_MINIMUM_VERSION` on PATH or in npm's global bin directory
(`not_found` when neither is present). `OAR_BOTTEGA_BIN` pins an executable,
which may be a launcher (below). Install and update checks use npm.

`listModels` runs `bottega models --json --stale` in the session environment:
the models bottega holds a key for, from provider environment variables (the
names pi reads), `BOTTEGA_HOME/.env`, custom endpoints in
`BOTTEGA_HOME/settings.json` (key `BOTTEGA_KEY_<ID>`), and a Codex ChatGPT
login in `CODEX_HOME/auth.json`. An empty list is `unauthenticated`. Bottega
manages these itself; OAR has no login for it.

Two members are absent, each after checking bottega 0.3.0 for its own
interface: `upgrade`, because bottega has no self-update command (`install`
reinstalls the npm package, and a bundled bottega moves with the OAR that
carries it); and `accountUsage`, because neither `bottega serve` nor the
command line reports a plan, quota or balance. Each step's tokens and cost
arrive as `step` lines on the stream instead.

## Running it in a container

The adapter spawns the pinned executable with the session's `cwd` as its
working directory and sends the same path in `open`. A launcher such as

```sh
#!/bin/sh
exec docker exec -i "$BOX" bottega "$@"
```

runs bottega and the agent's shell inside the container. The project must be
mounted at the path it has on the host, and the session's environment
(`SessionOptions.env`) reaches the launcher, not the container.

## Evidence

- `OAR_TEST=bottega-aimock pnpm sea-trial` against the real `bottega serve`:
  19 passed, 1 skipped (`accountUsage`), with 0.3.0 from npm beside OAR and
  with `OAR_BOTTEGA_BIN` (2026-11-28); `OAR_TEST=bottega-aimock pnpm vitest
  run sea-trial/vendor`: 3 passed. Linux CI runs both (`bottega-aimock`). The
  fixture's home has only a loopback endpoint, an empty `CODEX_HOME`, and a
  stand-in `raft` first on PATH.
- `pnpm vitest run tests/bottega`: the projection, the options and the
  adapter against a scripted `bottega serve` (22 tests); with
  `OAR_BOTTEGA_BIN`, 6 more against the real process: where each kind of
  input lands on the screen the provider is sent, the Raft app coming on for
  a Raft wake, appended instructions, resume, and the abort and run-of-events
  points above. The failed-turn rule is tested in bottega's own
  `bottega/src/serve.test.ts`.
- Not verified: Windows; macOS in CI; images; a provider failure through the
  real process; a host's own MCP servers.
