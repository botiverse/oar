# Bottega

**Community runtime, experimental**, maintained by the
[bottega](https://github.com/botiverse/bottega) maintainers. It lives in
`packages/oar/src/community/bottega/` and is
exported from `@botiverse/oar/community`, not `defaultRuntimes`; a host adds it
with `createRuntimeRegistry([...defaultRuntimes.list(), createBottegaRuntime()])`.
Its tests (`tests/community/bottega/`) run only with `OAR_COMMUNITY_TESTS=1`.

Evidence baseline: [`botiverse/bottega`](https://github.com/botiverse/bottega)
branch `claude/oar-adapter` at `ab6a86a`, which adds `bottega serve`
(protocol 1, `bottega/src/serve.ts`), bottega 0.2.0, 2026-11-25. A version is
an evidence baseline, not a support range. That branch is not merged, and no
released bottega has `serve`: until one does, the runtime is experimental and
its interface may change with it.

## Native concepts and calling interface

Bottega is an agent harness whose context is a screen of app windows drawn
again each step, not a transcript. Three of its ideas shape this mapping:

- a **session** is a directory under bottega's home, keyed by the working
  directory it was made for and its id; it holds the windows, the
  conversation and a record of every step, and can be taken up again;
- the agent **speaks by acting**: a reply is a post into the conversation
  app. Text a model writes without sending reaches nobody, and a turn ends
  when a step calls nothing;
- the world reaches a session through its **inbox**: an event wakes the
  session and leaves one pointer line on the screen, and what there is to
  read stays in the app that holds it. Under `serve`, how often events may
  start turns is the host's rule; bottega starts none after the person
  stopped the agent or a turn failed, until the person says something.

`bottega serve` is the calling interface: one process, one session, JSON
lines on stdin and stdout. Commands are `open`, `resume`, `prompt`, `steer`,
`cancel`, `dispose`; each is answered once. Every other line out is something
that happened: `ready`, `turn_started`, `said`, `action`, `note`, `step`,
`input_dropped`, `turn_ended`.

## Mapping to OAR

| Native | OAR |
| --- | --- |
| `bottega serve` process | One per session (`execution: "process"`, isolated). `OAR_BOTTEGA_BIN` pins the executable; it may be a launcher that runs bottega elsewhere (see [Running it in a container](#running-it-in-a-container)). |
| Session id | `Session.id`. `resume` names it with the same `cwd`; a missing one is `SessionNotFoundError`. |
| Provider and model | `model` as `provider/model` (the model id keeps its own slashes: `openrouter/deepseek/deepseek-v4.1-flash`). A saved session keeps its route: a resume that asks for another is refused. |
| Reasoning level | `effort`, in bottega's spelling: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| Task-specific instructions | `appendSystemPrompt`, placed after bottega's own prompt. A resume that gives another replaces it at once; one that gives none keeps the saved text. `systemPrompt` is refused: bottega's prompt says how to read the screen. |
| A line of the conversation | `prompt` / `steer` with `origin.kind` `user` or no origin: a `user_message` (`evidence: "conversation"`). |
| An inbox event | `prompt` / `steer` with `origin.kind` `notification` or `automation`: bottega is told whose input it is, and takes it as an event signed by `origin.source`. No `user_message` follows. When bottega's own rules start no turn for it, the input comes back as `input_dropped` (`runtime_refused`, with bottega's reason) and the session is idle again. |
| Post by the agent | `text_delta`, one per post, `messageId` the conversation's turn id. |
| Action | `tool_call_started` + `tool_call_ended` in one frame, the note as text content. No `result`: bottega reports none. Unsent text is `reasoning`. |
| Step | `usage` (running totals; `context` is the prompt against the session's context budget) and `model` when the route changes. |
| Turn end | `completed`, `aborted`, `failed` (`unknown`: the reason is prose), or `failed` `limit_reached` when the session's step limit stopped the turn. |
| Queue | Held by the adapter (`durable: false`), prompted with `carries` when the turn ends, with the origin it was given; `withdraw` takes it back before that. |

Refused options are in [`options.ts`](../../packages/oar/src/community/bottega/options.ts):
`systemPrompt`, `mcpServers`, `disallowedTools`, `launchArgs`, `serviceTier`,
`additionalDirectories`, `outputSchema`, `name`, `userConfiguration`, `goals`,
`endTurnProcessesOnAbort`. No `listModels`, account usage, login or install
capability is declared.

## What a host should know

- How often notifications may start turns is the host's to decide: a served
  session has no bound on event-started turns in a row (bottega's desktop
  has one; a host such as Raft's daemon, which marks a person's message as a
  notification too, has its own delivery rule). After an `abort` or a failed
  turn, each further notification is dropped until an input with
  `origin.kind: "user"` arrives. This is bottega's rule, observed here, not
  an adapter choice. The abort and an unbounded run of notifications are
  tested here against the real process; the failed turn in bottega's own
  `bottega/src/serve.test.ts`.
- A steer put into a turn that is aborted before its next step starts the
  turn after: the stream shows the abort's `turn_ended`, then a `turn_active`
  naming the steer's `inputId`.
- A notification's text is one pointer line (bottega keeps 1,000 characters
  of it). Content belongs in an app of the session.

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

## Evidence and verification

- Shared behavior suite against the real `bottega serve` with a scripted
  provider: `OAR_BOTTEGA_BIN=<bottega> OAR_TEST=bottega-aimock pnpm sea-trial`
  (2026-11-12: 17 passed, 2 skipped for `accountUsage` and `listModels`).
- `OAR_COMMUNITY_TESTS=1 pnpm vitest run tests/community/bottega`: the
  projection, the options, the adapter against a scripted `bottega serve`,
  and, with `OAR_BOTTEGA_BIN`, the real one: where each kind of input lands
  on the screen the provider is sent, the appended instructions, resume, and
  the three points under [What a host should know](#what-a-host-should-know).
- Not verified: Windows; images; a provider failure through the real
  process; a host's own MCP servers.
