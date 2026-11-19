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
/** The most recent request the root agent sent to its model; null before the first one, from the start of a dispose, and once the process has exited. */
lastModelRequest?(): Promise<ModelRequest | null>;

export interface ModelRequest {
  /** When OAR captured it (ISO 8601). */
  readonly at: string;
  /**
   * `wire`: the provider body as the runtime built it.
   * `harness`: the runtime's own request before its provider adapter
   * converts it (cache markers and format conversion not applied).
   * Either way it is the whole context of that call, never a delta.
   */
  readonly fidelity: "wire" | "harness";
  /** The schema of `body`: `anthropic.messages`, `openai.responses`, `openai.chat`, `google.generate_content`, or a runtime's harness schema (`pi.context`, `dsh.request`). */
  readonly format: string;
  /** The JSON body, unchanged except for the redactions below. */
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
  `lastModelRequest` member.
- **Refused, never faked.** A runtime that exposes no request refuses the
  option at open with `UnsupportedOptionError`, and declares the refusal in
  `refusedSessionOptions` (per installation where a version floor applies,
  through `installedSessionCapabilities`). A host decides before opening, by
  that declaration, never by runtime name (Raft keeps its old driver for an
  agent with View Context on when the option is refused).
- **Only what the runtime exposes at request time.** OAR does not rebuild a
  request from the native transcript. A transcript lacks the system prompt
  and tool schemas, which are what this view is for, and the rest is the
  conversation the host already projects from the record stream. A host
  without this member shows its conversation, `contextUsage()`, and
  `contextBreakdown()` where present.
- **No traffic interception.** OAR never points a runtime's base URL at a
  proxy of its own to read requests. A proxy would sit in the credential
  path, change what the runtime connects to, and fail for runtimes whose
  prompt is built on the vendor's server (Cursor, Devin).
- **The whole context, never a delta.** Some runtimes send only what is new
  since the previous call (Pi with Anthropic message threads continues a
  server-side thread; Codex over WebSocket may send incremental requests).
  OAR captures the complete request before that trimming, so the answer
  always shows everything the model had for that call.
- **Current as soon as the request is sent.** OAR replaces the kept request
  when the runtime sends the next one, before its response, and the reading
  is valid at any moment, including mid-turn. A host that indexes requests
  by something it observes during a turn (a message the agent sent through
  a tool) reads at that moment: while a tool runs, the latest request is the
  one whose response called it. Where the native mechanism writes a file,
  the reading takes the newest complete file at the time of the call.
- **The latest root request, not a history.** OAR keeps one request per
  session and replaces it on the next. Requests a sub-agent sends are not
  returned; a runtime that cannot tell them apart refuses the option until
  it can. A host that wants a history reads when it needs one and stores it
  in its own data layer
  ([replay boundary](../design/foundations.md#replay-boundary)).
- **Read, never recorded.** Like `contextBreakdown()`, reading changes
  nothing in the session, so it enters no record. Recording bodies would
  grow the stream with the square of the conversation length.
- **Body only.** OAR never captures transport headers. Credentials OAR knows
  of (the ones it redacts elsewhere) are redacted from string values before
  the body is returned.
- **OAR cleans up what it enables.** Where a runtime dumps bodies to files,
  OAR points it at a directory OAR owns for that session, removes older
  files as new ones arrive, and removes the directory at dispose. It writes
  no user configuration.

## What runtimes expose

Read from installed packages and source on 2026-11-19 (claude 2.1.328, pi
1.5.2, opencode 1.19.6 and 2.3.2, dsh 0.2.2-rc). Rows marked "to verify" are
read from binary strings or documentation, not run.

| runtime | mechanism | fidelity | to verify |
| --- | --- | --- | --- |
| claude | `OTEL_LOG_RAW_API_BODIES=file:<dir>` writes each request body | wire | written when the request is sent, not at turn end; works with telemetry export off; first version; sub-agent requests distinguishable; `withheld` bodies |
| pi | extension event `before_provider_request`, through the extension factories OAR already passes | wire | carries the full request, not the message-threads delta (Raft's `onPayload` relies on this) |
| opencode 2.x | plugin hook `http.request`, through the config OAR already passes in `OPENCODE_CONFIG_CONTENT` | wire | every provider passes through the hook |
| opencode 1.x | plugin transforms for system, messages, params and tool definitions | harness | |
| dsh | `request/header` (config and tool schemas) plus derived messages, through OAR's in-process bridge | harness | |
| codex | `CODEX_ROLLOUT_TRACE_ROOT` rollout trace | wire, to verify | payload shape; whether WebSocket incremental requests leave a full body to read |
| qwen | `--openai-logging` | wire, to verify | OpenAI-compatible providers only |
| pi-durable | Harness `beforeProviderRequest` | wire | the host creates the Harness, so it can hook it itself; OAR refuses |
| kimi, grok, antigravity, factory, codebuddy, qoder | transcript only | none | refuse |
| cursor, devin, cybion, morph, maka | prompt built on the vendor's server | none | refuse |

## Order

1. Claude first: Raft's Claude migration needs it, and the native dump
   replaces Raft's transcript reconstruction.
2. Pi: Raft's Pi migration declines agents with View Context until this
   lands.
3. OpenCode 2.x and DSH.
4. Codex and Qwen once their mechanisms are verified.

A format-aware projection for display (system, tools, messages from any
`format`) is a separate, later helper. It belongs with the other Node-free
projections and needs a host asking for it first.
