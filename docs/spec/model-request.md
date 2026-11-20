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
/** Keep the most recent model request for `Session.lastModelRequest()`. Refused where the runtime exposes no request (`refusedSessionOptions.modelRequests`, a new `RefusableSessionOption`). */
readonly modelRequests?: "latest";

// Session, present only on a session opened with modelRequests
/** The most recent main-loop request the runtime attributed to the root agent in this open; null before the first one, from the start of a dispose, and once the process has exited; rejects when an attribution OAR was waiting for did not arrive (see Checked). */
lastModelRequest?(): Promise<ModelRequest | null>;

export interface ModelRequest {
  /** When the runtime built the request (ISO 8601), not when OAR read it. */
  readonly at: string;
  /** The schema of `body`: `anthropic.messages`, `openai.responses`, `openai.chat` or `google.generate_content`. */
  readonly format: string;
  /** The request as the runtime recorded it, the whole context of that call; absent when the runtime withheld it whole or did not capture it (`withheld` says which). Not byte-identical to the wire: see `withheld` and the runtime's row. */
  readonly body?: unknown;
  /** What the runtime replaced or removed before OAR saw the body, as far as the runtime's row says OAR can tell (claude: thinking text, or the whole body), named by OAR since a runtime may not name its own rewrites. */
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
  request when the runtime attributes a new main-loop request to the root.
  Where the runtime attributes a request when it sends it, that is before
  the response. Where attribution follows the response (claude's file mode,
  below), OAR knows from the session's own events that the model answered a
  main-loop call before its attribution lands (a response the runtime made
  up for an error does not count; the runtime's row names which events do);
  a read in that gap waits for it,
  bounded (the runtime page states the bound), so while a tool runs the
  reading is the request whose response called it, and a host that indexes
  requests by something it observes during a turn (a message the agent sent
  through a tool) reads at that moment. Where the native mechanism writes a
  file, a file is complete only when it parses as a whole; a partly written
  file is never returned.
- **Attributed attempts only.** A request that is never attributed (claude
  attributes only a call that was answered: a refused, failed, interrupted
  or retried attempt leaves no attribution) never becomes the kept request.
  After a failed turn the reading can therefore be an earlier request; `at`
  tells the host when it was built. Of a retried call, the kept request is
  the attempt that was answered.
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
- **One session per capture.** A process-wide switch (an environment
  variable, a startup flag) is never set for a shared process. Unless the
  runtime attributes each request to its session, a session opened with
  `modelRequests` runs in its own process: `placement: "auto"` selects
  isolated, and `placement: "shared"` is refused as a placement
  (`UnsupportedOptionError` naming `placement`). The option's own refusal
  stays a per-installation declaration that does not depend on placement.
- **Checked, never assumed.** Where the user's or the project's
  configuration can redirect or disable the mechanism, OAR sets it at the
  highest precedence it controls without writing user configuration, and
  reads the effective setting back at open where the runtime reports it: a
  setting other than OAR's refuses the option at open
  (`UnsupportedOptionError` naming `modelRequests` and the winning source).
  A setting can still change after open (claude re-reads its environment on
  every request, and managed settings can refresh), so the wait above is
  also the check: when a main-loop response's attribution does not arrive
  within the bound, `lastModelRequest()` rejects with the cause, and so does
  every read until an attribution lands, rather than return an older
  request or `null`. A turn that ends failed or aborted ends the wait
  without a rejection: its last call may never be attributed.
- **Body only.** OAR never captures transport headers. The body passes
  through the session's credential redactor
  ([`shared/credential-redactor.ts`](../../packages/oar/src/shared/credential-redactor.ts))
  before it is returned, as every other value OAR returns does.
- **OAR cleans up what it enables.** Where a runtime dumps bodies to files,
  OAR points it at a private directory it creates for that session before
  spawn, outside the session's working directory
  ([`shared/private-temp.ts`](../../packages/oar/src/shared/private-temp.ts),
  which also sweeps directories a dead host left behind), and removes the
  directory at dispose. While the session runs it deletes only files it no
  longer needs: those its attribution already named, other than the kept
  request, and unattributed request files built before the kept request (an
  attempt that will never be attributed). It never deletes a request newer
  than the kept one, which may still be in flight, and never rotates the
  runtime's own index, which therefore grows for the whole session. An
  index line can name a file OAR already deleted (an unattributed sub-agent
  or auxiliary request it never keeps); the reader skips it. It writes no
  user configuration.

## What runtimes expose

Read from installed packages and source on 2026-11-19 (claude 2.1.328, pi
1.5.2, opencode 1.19.6 and 2.3.2, dsh 0.2.2-rc). The claude and pi rows were
then checked in the installed code: claude from the 2.1.328 binary's strings
(`[sym]`), pi from the installed 1.5.2 packages (`[src]`). Nothing here has
been run; each "to verify" item must be checked live before the runtime ships.

| runtime | mechanism | to verify |
| --- | --- | --- |
| claude | `OTEL_LOG_RAW_API_BODIES=file:<dir>` (`[sym]`). Each request writes `<uuid>.request.json` when the request is built, before the response, with no rename, so a reader can meet it half written. After an answered response claude writes `<request_id>.response.json` and appends, asynchronously, one line to `index.jsonl` naming the request file, `session_id`, `query_source` and the response's message id, which OAR joins to the root `assistant` frame on stream-json to know an attribution is pending. Only a frame from a model response arms that wait: claude also emits a root `assistant` frame it made up for an API error (`is_api_error_message`, or model `<synthetic>`, as [`claudeSyntheticAssistant`](../../packages/oar/src/runtimes/claude/failure.ts) detects), which gets no index line, and an interrupted response can emit frames and get none either; the turn's failure or abort ends the wait. An index line can name no request file, when claude skipped the capture: OAR returns that attribution with `body` absent and `withheld: ["not_captured"]`. The request file itself carries no source; `at` is approximately its build time: the file's modification time, its last write just after the build. A refused, failed, interrupted or retried attempt writes a request file and no index line. Main loop: `query_source` `sdk` under OAR's stream-json launch (`repl_main_thread*` in the interactive REPL), the two claude itself classifies as main; sub-agents `agent:builtin:<type>`, `agent:custom:<type>`, `agent:default` and `hook_agent`; auxiliary calls name their own source (`compact`, `generate_session_title`, classifiers, memory extraction and others). File mode needs no telemetry exporter. Claude rewrites the file without naming it: thinking text becomes `<REDACTED>` and account memory text is substituted; it withholds a body whole (`{not_recorded: …}`, any source including `sdk`) for memory operations and account memory it cannot identify or redact. OAR names the redacted thinking and a whole withhold in `withheld` (the file marks both) and leaves `body` absent for a whole withhold. A substitution of account memory leaves no mark OAR can see, so `withheld` never names it, and the runtime page says a body may carry substituted account memory. Under Bedrock, Vertex, Foundry or a gateway the file holds the Messages request claude built, not the transport wrapper, so `format` is `anthropic.messages` and `provider` comes from claude's provider selection. Claude creates a missing directory with default permissions and never deletes files. Settings `env` entries are written over the launch environment, so a user's settings would replace a value OAR put in the process environment (project and local settings cannot set this variable). OAR passes it in the `env` of the one `--settings` object it builds (which also carries `fastMode` and `claudeMdExcludes` when those are set), and refuses a host `--settings` in `launchArgs` whenever it sends its own, since claude replaces a repeated `--settings` ([`claudeSettingsArgs`](../../packages/oar/src/runtimes/claude/launch-args.ts)). That source is applied after user, project and local settings, in trusted and untrusted workspaces alike, and only managed policy settings (or `CLAUDE_CODE_REMOTE_TOOLS_PIN_STORED_LOGIN`, which withholds non-policy settings env) override it. OAR reads the effective value back through the `get_settings` read-back OAR already uses for effort, which also names the winning source; a value other than OAR's refuses the option at open, naming that source. The directory is created 0700 before spawn, on fresh, resumed and forked launches alike. The gate that disables the mechanism is `diskless`, which only an embedding claude-code-server sets; a CLI launch is never diskless. Any other truthy value selects inline mode, which puts bodies in the telemetry event; OAR never uses it | first version, which sets the declared floor (2.1.304 and 2.1.322 have the same code; 2.1.292 not checked); a live run under OAR's launch (`[env]`), including how long after the `assistant` frame the index line lands, which sets the read bound |
| pi | extension event `before_provider_request` (`[src]` pi-coding-agent `extensions/runner.js`), wired as the Agent's `onPayload`. Every provider adapter calls it with its built request. The Anthropic adapter builds the full history, system prompt and tools whether or not message threads are on (the flag only adds a beta header), calls the hook, and only then lets `prepareThreadRequest` trim to a thread delta. A handler's return value replaces the body, so OAR's handler returns nothing. Only the main loop passes `onPayload`: compaction and branch summaries build their options without it, cache warming calls the model runtime directly, and 1.5.2 makes no title call. In RPC mode the event runs in the pi child, and the JSON-line stdout carries every control response, so a body leaves through a side channel, never that line: the RPC protocol relays no extension data channel, and every surface an extension can reach (UI requests, notifications) is a line on that stdout. A file, or a separate pipe like the fd 3 credential pipe OAR's own Pi extension already opens | a live run: one hook call per main-loop request and none for compaction (`[env]`) |
| opencode 2.x | a plugin in the config OAR already passes in `OPENCODE_CONFIG_CONTENT` (loaded as a virtual document, no file; `[sym]` 2.3.2), using two hooks; OAR injects no plugin today. `model.request` receives the provider-neutral prompt with its `kind` (`primary`, `title`, `code`, `task`, `image`) and headers a plugin may write; `http.request` receives the final HTTP `Request` after the provider adapter. The plugin tags the request's headers in `model.request` and, in `http.request`, keeps the body only of a request tagged `primary`, as OpenCode's own Claude agent and Copilot plugins already pair them. No hook sees a WebSocket frame, so a WebSocket transport (OpenAI Codex's default) refuses | that the tag reaches every HTTP provider's `Request`. A body cannot go back over ACP stdout, which carries every control response and event as one JSON line each, so the plugin writes it to a file in OAR's per-session directory, as claude does |
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
