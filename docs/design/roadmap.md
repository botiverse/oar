# Design roadmap

This plan follows [system.md](system.md). It is a sequence of evidence-backed
increments, not a promise to add every feature listed.

## Shipped foundation

- A provider-independent runtime registry with installation, model, account
  usage, native inventory, update check and session entry points.
- One lossless, attributed, resumable record stream with explicit, typed
  controls (`prompt`, `steer`, `queue`, `withdraw`, `abort`, `deliver`,
  `dispose`), input identity and origin, images, and task events for runtime
  background work.
- Read models over that stream: status, conversation, session view, usage,
  context, tasks.
- `@botiverse/oar/agents` and `oar mcp`: subagents on any runtime, reported
  back through a host-owned hook.
- `serveMcpTools`: tools the host implements, served to any runtime that
  takes MCP servers, with server instructions and a tool list the host can
  replace mid-session (`Runtime.mcpToolsListChanged` says whether a running
  session sees the change).
- Runtime config forms (`@botiverse/oar/forms`): each runtime describes its
  settings as data a host renders and may only narrow
  ([capabilities](capabilities.md#a-form-for-choosing-settings)).
- Capabilities as types ([capabilities](capabilities.md)): absent members for
  missing operations, `UnsupportedOptionError` for refused options
  (`ResumeCwdError` when a resume cannot honor or confirm its directory),
  `ModelConfirmationError` when opening cannot confirm the requested model,
  synchronous `installedSessionCapabilities(runtime, installation)` via
  `@botiverse/oar/capabilities`, declared credentials (`Runtime.credentials`),
  and native payload reachability and read-backs.
- Runtimes whose SDK or engine the host installs and hands over
  (`createCursorRuntime`, plus `createPiDurableRuntime` under
  `@botiverse/oar/pi-durable`), community runtimes under
  `@botiverse/oar/community` (`createMorphRuntime`, `createCybionRuntime`),
  optional Pi SDK installation in `@botiverse/oar`, one package entry per
  built-in runtime (`@botiverse/oar/runtimes/<id>`) so a host loads only what it uses,
  and a clean-install check of the published packages.
- Placement as a declared runtime choice ([system](system.md#placement)):
  `Runtime.execution`, Pi through its own RPC process
  (`createPiRuntime({ execution: "subprocess" })`), Cursor's SDK in a Node
  child per session with an environment the session chooses
  (`createCursorRuntime({ execution: "subprocess", sdkModule, envBase })`), and `withPlacement` for
  shared or isolated runtime processes. No native runtime is admitted to
  shared placement today.
- Interrupt delivery for runtimes without steer
  (`deliver(input, { when: "interrupt", maxWaitMs, merge })`), sessions that
  skip user-level configuration (`userConfiguration: "exclude"`), background
  memory control (`nativeMemoryDefault`, `SessionCapabilities.nativeMemory`),
  session-log upload control (`SessionOptions.sessionLogUpload`), and login,
  logout and status in the environment a session uses (`env`,
  `userShellEnvironment()`).
- Native controls and read-backs with attributable results: manual compaction
  (`Session.compact`, `Runtime.manualCompaction`), single-task stop
  (`Session.stopTask`), account limit resets (`Runtime.redeemLimitReset`; claude's through its
  interactive UI with `Runtime.inspectLimitResets`),
  ending an aborted turn's processes (`endTurnProcessesOnAbort`), measured
  resume timing (`Runtime.resumedSessionOptions`), bounded retention by
  eliding old frame content (`retainedBytes`), attributed latest model
  request (`SessionOptions.modelRequests: "latest"`, `Session.lastModelRequest`),
  native persisted file location (`Session.nativeSessionFile`), and one-shot
  forked questions (`Runtime.sideQuestion`)
  ([decisions](decisions.md), [model-request](../spec/model-request.md)).
- Mock, aimock, vendor, experiment and live validation layers, with voyage
  logs as durable evidence.
- Bounded `orient()` snapshots with local, account and models depths, explicit
  missing evidence and opt-in customization inventories. Hosts own readiness
  policy. [Contract](../spec/orientation.md).

## Next increments, in dependency order

### 1. Make actions self-describing

**Shipped:** a rejected control carries a typed `code` beside the prose
`reason` (`aborted`, `busy`, `no_active_turn`, `not_queued`, `unsupported`,
`runtime_exited`, `session_released`, `disposed`, `runtime_refused`,
`session_not_found`, `error`); `Session.status()` is a query whose
`busy` matches its `running`; `awaitIdle` and `promptAndWait` (with
`timeoutMs` and `signal`) write the wait, abort and settle sequence once;
`TurnOutcome` `failed` carries `FailureClass` (with `credential`, `status`,
`resetsAt` and `rateLimitType` where the runtime says them) and `failureAdvice`
turns a class into a retry policy. Spec: [record-stream.md](../spec/record-stream.md),
[runtime-matrix.md](../spec/runtime-matrix.md#failure-evidence); regression:
`tests/turns.test.ts`; sea-trial: `session.single-active-turn`.

**Open:** runtimes whose failure prose carries no structured classification
still land in `unknown` (or lack structured resets such as `rate_limited`
backoffs).

**Acceptance:** a caller can choose retry, queue, hand off or stop without
parsing prose; rejected input is provably caller-owned.

### 2. Make continuation first-class

If a consumer needs a handoff, define only a provider-independent shape for
runtime identity, model, cursor, graph, capability decision and next action;
storage and lifecycle stay wholly host-owned. What a native resume keeps
after a crash is measured per runtime in
[crash and resume](../runtimes/crash-resume.md).

**Acceptance:** a new worker can resume or reject a handoff from the artifact
alone and explain every irrecoverable gap.

### 3. Make evidence economical

Add bounded replay and projection helpers only for measured needs. Prefer
incremental folds and cursors to rescanning unbounded logs; keep the voyage
format versioned and forward compatible.

**Acceptance:** live reconnect and offline replay produce equivalent
projections without duplicate controls.

### 4. Change model and effort without a restart

**Shipped at open:** `SessionOptions.model` and `effort` apply at open and are
read back against the runtime's own report; each adapter refuses an open the
runtime does not confirm. The caller was Ferry, which switches model and
effort between turns by resuming and must show the level the runtime really
runs; the runtimes otherwise lose a level silently (claude ignores an unknown
one with a stderr warning, lowers `xhigh` to `high` on a 4.6 model and sends
none for haiku, pi clamps, and a `config`
override on codex's `thread/resume` rebuilt the thread onto `config.toml`'s
model). Effort is reported by the `effort` event, `Session.effort()`
and `SessionView.effort`. Regression: per-adapter unit tests, sea-trial
`session.effort-never-substituted` and
`session.effort-listed-levels-apply-across-resume`, and
`effort.vendor.test.ts` on the aimock backends.

**Next:** a `Session.configure` control over the native live setters
surveyed in [live-configure](../runtimes/live-configure.md) (claude, codex,
grok, kimi and pi; cursor's SDK types a model per send, not yet probed, and
antigravity is unprobed), which
would record the request, answer with the runtime's acknowledgement, and let
the `model` and `effort` events carry the effect. Today a host switches by
disposing at a turn boundary and resuming with new options.

**Gate:** a host whose restart cost is measured (hook reruns, MCP startup,
lost prompt cache), and a decision on pi, whose setters rewrite the user's
global defaults.

**Acceptance:** a change requested while input is queued lands before that
input on every runtime, and no runtime reports a level it does not run.

### 5. Extend control across placement

Only when a real host needs remote or multi-client operation: remote
placement is `oar serve` on the agent host with a thin application-side
client, and adapter-as-client is limited to managed cloud runtimes
(architecture v4, Raft thread `#all:e1d09817`, message `5b5e279b`). One
supporting page has no draft yet: the transport binding (from message
`b95d8f33`). A remote client cannot read which members a session has, so the
binding must carry the facts [capabilities](capabilities.md) keeps in types.
Preserve ordering, cursors, attribution and native reachability; do not
create a remote-only contract.

**Acceptance:** local and remote hosts pass the same behavior cases and define
disconnect and reconnect by evidence rather than heartbeat guesses, and a
remote client chooses actions from the same capability facts as a local one.

## Decision gates

Public additions must pass the [design decision gates](decisions.md#decision-gates).
Keep ideas that lack evidence here or in an experiment.
