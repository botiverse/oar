# What the model received

> **Status: designed, not implemented.** Types below are the intended
> contract; a runtime ships it only after its row in the verification
> column is done.

A host shows a user what the model was actually sent: the system prompt, the
tool definitions, the messages, the model and its parameters. Raft calls this
View Context. Today a host gets it per runtime: a Pi request hook in Raft's
own Pi driver, and for Claude a reconstruction from the native transcript,
which has no system prompt and no tool schemas. Neither carries over to the
next runtime.

OAR offers one surface for it: a session opened with `modelRequests:
"latest"` keeps the most recent request the runtime sent to its model, and
`Session.lastModelRequest()` returns it.

## Proposed contract

```ts
// SessionOptions
/** Keep the most recent model request for `Session.lastModelRequest()`. Refused where the runtime exposes no request (`refusedSessionOptions.modelRequests`). */
readonly modelRequests?: "latest";

// Session, present only on a session opened with modelRequests
/** The most recent main-loop request the root agent sent to its model in this open; null before the first one, from the start of a dispose, and once the process has exited. */
lastModelRequest?(): Promise<ModelRequest | null>;

export interface ModelRequest {
  /** When OAR captured it (ISO 8601). */
  readonly at: string;
  /** The schema of `body`: `anthropic.messages`, `openai.responses`, `openai.chat` or `google.generate_content`. */
  readonly format: string;
  /** The provider body as the runtime built it, the whole context of that call, unchanged except for the redactions below. */
  readonly body: unknown;
  /** Parts the runtime itself withheld before OAR saw the body (claude replaces thinking text), as the runtime names them. */
  readonly withheld?: readonly string[];
  readonly provider?: string;
  readonly model?: string;
}
```

## Semantics

- **Opt in, because capture costs.** Some runtimes write every request body
  to disk, and each body repeats the whole conversation, so capture is off
  unless the host asks. A session opened without the option has no
  `lastModelRequest` member, and capture costs nothing: no hook installed,
  no file written, nothing sent across a process boundary.
- **Refused, never faked.** A runtime that exposes no request refuses the
  option at open with `UnsupportedOptionError`, and declares the refusal in
  `refusedSessionOptions` (per installation where a version floor applies,
  through `installedSessionCapabilities`). A host decides before opening, by
  that declaration, never by runtime name (Raft keeps its old driver for an
  agent with View Context on when the option is refused).
- **The provider body, as sent.** Only the body the runtime built for the
  provider counts. A runtime that exposes its request only before its
  provider adapter converts it (OpenCode 1.x transforms, DSH's request
  header) refuses for now: such a body has a schema per runtime, and a host
  would need runtime-specific parsing to show it.
- **Only what the runtime exposes at request time.** OAR does not rebuild a
  request from the native transcript or from events. A transcript lacks the
  system prompt and tool schemas, which are what this view is for, and the
  rest is the conversation the host already projects from the record stream.
  A host without this member shows its conversation, `contextUsage()`, and
  `contextBreakdown()` where present.
- **No traffic interception.** OAR never points a runtime's base URL at a
  proxy of its own to read requests. A proxy would sit in the credential
  path, change what the runtime connects to, and fail for runtimes whose
  prompt is built on the vendor's server (Cursor, Devin).
- **Observe, never alter.** A hook that receives the object the runtime is
  about to send copies it; redaction and every other change apply to the
  copy, never to what goes to the provider.
- **The whole context, never a delta.** Some runtimes send only what is new
  since the previous call (Pi with Anthropic message threads continues a
  server-side thread; Codex over WebSocket may send incremental requests).
  OAR captures the complete request before that trimming, so the answer
  always shows everything the model had for that call.
- **The root agent's main loop only.** Requests a sub-agent sends, and
  auxiliary calls (titles, summaries, compaction, classifiers, memory
  extraction), never replace the kept request. A runtime that cannot tell
  them from the root's main-loop requests refuses the option until it can.
- **Current as soon as the runtime attributes it.** OAR replaces the kept
  request when it can tell that the runtime sent a new main-loop request, and
  the reading is valid at any moment, including mid-turn. Where the runtime
  attributes a request when it sends it, that is before the response. Where
  the attribution arrives with the response (claude's file mode, below), the
  kept request changes when the response completes, and until then the
  reading is the previous main-loop request. Either way, while a tool runs,
  the latest request is the one whose response called it, so a host that
  indexes requests by something it observes during a turn (a message the
  agent sent through a tool) reads at that moment. Where the native mechanism
  writes a file, a file is complete only when it parses as a whole; a partly
  written file is never returned.
- **This open only.** A resumed session returns `null` until it sends its
  first request in this open. OAR does not read bodies an earlier process
  left behind.
- **The latest request, not a history.** OAR keeps one request per session
  and replaces it on the next. A host that wants a history reads when it
  needs one and stores it in its own data layer
  ([replay boundary](../design/foundations.md#replay-boundary)).
- **Read, never recorded.** Like `contextBreakdown()`, reading changes
  nothing in the session, so it enters no record. Recording bodies would
  grow the stream with the square of the conversation length. Reading must
  not block the session's control channel: a runtime in a child process
  keeps the body there or in its file until it is read.
- **One session per capture.** `modelRequests` with `placement: "shared"` is
  refused unless the runtime attributes each request to its session; a
  process-wide switch (an environment variable, a startup flag) is never set
  for a shared process.
- **Body only.** OAR never captures transport headers. Credentials OAR knows
  of (the ones it redacts elsewhere) are redacted from string values before
  the body is returned.
- **OAR cleans up what it enables.** Where a runtime dumps bodies to files,
  OAR points it at a directory it creates for that session, readable only by
  the user (0700) and outside the session's working directory, removes older
  files as new ones arrive, and removes the directory at dispose. It writes
  no user configuration.

## What runtimes expose

Read from installed packages and source on 2026-11-19 (claude 2.1.328, pi
1.5.2, opencode 1.19.6 and 2.3.2, dsh 0.2.2-rc). The claude and pi rows were
then checked in the installed code: claude from the 2.1.328 binary's strings
(`[sym]`), pi from the installed 1.5.2 packages (`[src]`). Nothing here has
been run; each "to verify" item must be checked live before the runtime ships.

| runtime | mechanism | to verify |
| --- | --- | --- |
| claude | `OTEL_LOG_RAW_API_BODIES=file:<dir>` (`[sym]`). Each request writes `<uuid>.request.json` when the request is built, before the response, with no rename, so a reader can meet it half written. After the response claude writes `<request_id>.response.json` and appends one line to `index.jsonl` naming the request file, `session_id` and `query_source`. The request file itself carries no source. Main loop: `query_source` `repl_main_thread*` or `sdk`; sub-agents `agent:*`; auxiliary calls name their own source (`compact`, `generate_session_title`, classifiers, memory extraction and others). File mode needs no telemetry exporter. Thinking text is replaced with `<REDACTED>`; memory operations and a summary with account memory are withheld whole. Claude creates a missing directory with default permissions and never deletes files. Any other truthy value selects inline mode, which puts bodies in the telemetry event; OAR never uses it | the main-loop source under OAR's stream-json launch (`sdk` expected); that a settings `env` entry cannot override OAR's value (the variable is in claude's settings-env lists); the disabling `diskless` launch gate; first version (2.1.304 and 2.1.322 have the same code; 2.1.292 not checked) |
| pi | extension event `before_provider_request` (`[src]` pi-coding-agent `extensions/runner.js`), wired as the Agent's `onPayload`. Every provider adapter calls it with its built request, and the Anthropic adapter calls it before `prepareThreadRequest` trims to a thread delta. A handler's return value replaces the body, so OAR's handler returns nothing. Cache warming and compaction call the model directly, without the Agent's `onPayload` | whether `buildParams` with message threads already shapes a partial history; that no title or summary call reaches `onPayload`. In RPC mode the event runs in the pi child, and the JSON-line stdout carries every control response, so a body must leave through a side channel (a file or a separate pipe), never that line |
| opencode 2.x | plugin hook `http.request`, through the config OAR already passes in `OPENCODE_CONFIG_CONTENT` | every provider passes through the hook; auxiliary calls (titles, summaries) distinguishable; how a large body leaves the server process |
| codex | `CODEX_ROLLOUT_TRACE_ROOT` rollout trace | payload shape; whether WebSocket incremental requests leave a full body to read; auxiliary calls distinguishable |
| qwen | `--openai-logging` | OpenAI-compatible providers only; whether the log directory can be per session; whether background memory extraction lands in the same log |
| opencode 1.x, dsh | request exposed only before the provider adapter converts it | refuse until a provider-body hook is found |
| pi-durable | Harness `beforeProviderRequest` | the host creates the Harness, so it can hook it itself; OAR refuses |
| kimi, grok, antigravity, factory, codebuddy, qoder | transcript only | refuse |
| cursor, devin, cybion, morph, maka | prompt built on the vendor's server | refuse |

## Order

1. Claude first: Raft's Claude migration needs it, and the native dump
   replaces Raft's transcript reconstruction.
2. Pi: Raft's Pi migration declines agents with View Context until this
   lands.
3. OpenCode 2.x.
4. Codex and Qwen once their mechanisms are verified.

A format-aware projection for display (system, tools, messages from any
`format`) is a separate, later helper. It belongs with the other Node-free
projections and needs a host asking for it first.
