# @botiverse/oar

Provider-independent TypeScript contracts and built-in implementations for controlling and observing Antigravity, Claude, Codex, CodeBuddy, Cursor, Grok, Kimi, OpenCode, Pi, Pi Durable, Qwen Code, and Qoder.

```ts
import { defaultRuntimes, promptAndWait } from "@botiverse/oar";

const runtime = defaultRuntimes.require("grok");
const installation = await runtime.installation?.();

if (installation?.kind === "available") {
  const session = await runtime.session(installation, { cwd: process.cwd() });
  session.events((event) => {
    switch (event.kind) {
      case "text_delta": process.stdout.write(event.text); break;
      case "tool_call_started": console.log(`[${event.tool}]`); break;
      case "turn_ended": console.log(event.outcome.kind); break;
    }
  }, { coalesceText: true });
  const run = await promptAndWait(session, "Inspect this repository");
  console.log(run.kind === "rejected" ? run.reason : run.outcome);
  console.log(session.usage(), await runtime.accountUsage?.(installation));
  await session.dispose();
}
```

`promptAndWait` uses your `inputId`, or generates a UUID, to associate native
queued/started reports with its answer. A notification turn before the input
starts does not satisfy that wait. Without those native reports it keeps the
request-based fallback. For a lower-level wait, pass the inputId to
`awaitTurnEnd(session, requestSeq, inputId)`; omitting it waits for the first
root turn end after that cursor. `session.prompt()` already generates an id
when omitted; it is recorded on the returned prompt request. A native
before-start cancellation resolves an input-scoped wait as `aborted`, even
without a turn-end event. `awaitIdle` waits through an intervening notification
while a host prompt remains pending.

`session.events()` delivers flat, attributed `Event`s (native user message
echoes, text, reasoning, tool call start / later input / progress / end, turn
start and end, usage, model, effort, compaction start / end, retry, background
tasks and subagents started, updated and ended, runtime→app requests and oar's
answers, control rejections, withdrawn inputs, the process exit), each carrying
the `seq` and `agentPath` of the record it was read from. Kinds a runtime never
says (claude has no compaction start, ACP runtimes and cursor no compaction,
pi and pi-durable report retry) never appear; the runtime pages say which. It is a
projection over the record stream, which `session.rawEvents()` and
`session.records()` expose (`RawEvent`: `Frame` with the native payload
verbatim, `RequestRecord`, `ResponseRecord`) for consumers who need the
runtime's own frames. `tool_call_ended.exitCode` is the exit status a runtime
reports for a command it ran, absent where it reports none (claude); see
[tool outcomes](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#tool-outcomes).
In `session.usage()`, `TokenTotals.reasoning` is the part of `output` the
runtime reports as reasoning (codex, grok, pi, pi-durable, cursor; absent
elsewhere): never add it to `output` again
([reasoning tokens](https://github.com/botiverse/oar/blob/main/docs/spec/attribution.md#reasoning-tokens)).

Tool arguments can arrive while the model is still writing them. Append
`tool_call_input_delta.delta` as raw text; `tool_call_input.input` replaces
the whole input when complete. `SessionView` does this for you, marking a
tool's preview with `inputPartial: true` until the complete input arrives.
Claude's streamed `tool_call_started` carries no input, so read the later
input event before parsing arguments. Calls without a partial stream still
start with their complete input.

`session.deliver(input, { when, origin })` sends input the host produces (a
subagent's result, a finished job) at the right moment: a new turn when the
session is idle, so the agent wakes, otherwise steered into the turn or queued
behind it. `origin` is recorded so a UI can tell it from typed input.
`session.steer` exists only on a session whose runtime can steer (kimi,
antigravity and opencode v2 sessions have none; see
[session controls](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#session-controls)),
so a host offers a steer control by reading the member, never a runtime
name; `deliver` and `steerOrQueue` queue where it is absent. `session.withdraw(inputId)` takes a queued input back before it is
sent (`accepted`), or answers `not_queued` once it went; with it a UI offers
withdraw, edit (withdraw, then `queue` again) and send now (withdraw, then
`deliver`). It exists where OAR holds the queue itself (claude, pi, qwen, qoder, cursor
and the ACP runtimes), and on pi-durable through native submission cancellation, not on codex.
`session.resources()` reads the memory a runtime takes on the host: resident
bytes and a process count over the runtime process, its group and its
descendants, `null` once it has exited (and on Windows). It is a reading only,
never a handle: no pid leaves OAR. Sessions whose runtime runs in the host
process (pi, pi-durable, cursor) have none.

For conversation UIs, use the browser-safe `reduceConversation` projection
over `session.rawEvents()`. It joins input requests, responses and native
echoes by identity, including steer → queue fallback. See the
[conversation contract](https://github.com/botiverse/oar/blob/main/docs/spec/conversation.md).

`failureAdvice` suggests **when to retry**, based only on the failure class.
It does not establish that repeating an input or an entire turn is safe:
tools may already have run and files may already have changed. A host can
collect the evidence for its own recovery decision:

```ts
import { failureAdvice, type ConversationInput, type FailureClass, type Session } from "@botiverse/oar";

function recoveryEvidence(failure: FailureClass, input: ConversationInput, reopened: Session) {
  return {
    timing: failureAdvice(failure),
    inputState: input.state,
    dropReason: input.state === "dropped" ? input.reason : undefined,
    recordsAfterReopening: reopened.records(),
  };
}
```

An accepted input should not be resubmitted without a later drop. Even
`dropped` with `reason: "runtime_exited"` means only that no input echo was
observed before exit; a durable queue may still hold it. Inspect the reopened
session's records and what the runtime can restore before deciding to resend.
See [dropped input](https://github.com/botiverse/oar/blob/main/docs/spec/conversation.md#dropped-input).

## Public exports

The package has these public entry points, plus `@botiverse/oar/pi-durable` ([below](#host-owned-durable-sessions)) and `@botiverse/oar/community` for community runtimes (below):

- `@botiverse/oar`: the runtime registry and adapters, bounded `orient` snapshots, `defineRuntime`, `UnsupportedOptionError`, `RuntimeFailureError`, `SessionNotFoundError`, `SessionUnavailableError`, `serveMcpTools`, the `oar-voyage/3` recorder (`openVoyage`), and everything the brands and observe entry points below export. Node-only (adapters import `node:child_process` and runtime SDKs).
- `@botiverse/oar/browser`: portable contracts, registry, session kernel, observe helpers, agent report formatting, and branding. No Node adapters, process helpers or local image-file loaders.
- `@botiverse/oar/brands`: browser-safe runtime names and SVG icons.
- `@botiverse/oar/runtimes/<id>` (`claude`, `codex`, `codebuddy`, `pi`, `cursor`, `opencode`, `kimi`, `grok`, `antigravity`, `qwen`, `qoder`): one built-in runtime (`claudeRuntime`, …; cursor's is `createCursorRuntime`) without the others, for a host that needs only some of them. Each entry stays at about 1 to 2.5 MB of heap where the root entry takes about 50 MB (Node 26, [#405](https://github.com/botiverse/oar/pull/405)): the ACP SDK (about 20 MB) loads only when an ACP runtime first opens a session, lists models (kimi, grok, antigravity, codebuddy), reads grok's usage, signs Kimi in or out or reads its status, or creates the Qwen provider facade, and the pi and cursor SDKs when theirs first run. Node-only.
- `@botiverse/oar/observe`: the browser-safe pure derivations over `RawEvent`s and `Event`s (`eventsOf`, `graphOf`, `usageOf`, `coalesceText`, `observeAgent`, `reduceStatus`, `tasksOf`, `observeStalls`, `classifyTool`, `reduceConversation`, `viewOf`, …) with no Node or adapter imports, so a browser or Electron-renderer bundle can import it directly. The root export re-exports all of them.
  It also supplies `failureAdvice` (recovery timing per `FailureClass`) and `noticeText`, `noticeTone`, `phaseLabel`, `failureText` and `taskStatusLabel`, alongside `toolActionLabel` and `toolGroupSummary`: English display wording for OAR types, usable in JavaScriptCore too. Wording may change in a minor release; hosts must use the typed values for decisions, not parse the text ([display wording](https://github.com/botiverse/oar/blob/main/docs/spec/conversation.md#display-wording)).
- `@botiverse/oar/kernel`: the runtime-author SPI. `createSessionKernel` is the record stream every built-in adapter is built on (dense `seq`, cursor replay, control recording, the reachability rule) and `sealSession` derives the `Session` API face over an adapter. Pair with `defineRuntime` to ship a custom runtime (a scripted runtime for a host's tests, an in-process agent) without re-implementing the stream contract. `inputImagesRefusal` and `withInputImages` are the image rules every built-in runtime keeps, so a custom runtime refuses the inputs they refuse. `withdrawHeld` is the decision behind `withdraw` for a runtime that holds its own queue.
- `@botiverse/oar/agents`: subagents. `createSubagents()` starts child sessions on any runtime that takes `SessionOptions.env` (not cursor or pi-durable), returns a report for every turn they end, takes follow-ups, enforces depth and concurrency limits, and reports each child as a task. The host takes reports with `wait` / `next` or receives them through an `onReport` hook; with `formatReport` and `reportOrigin` it can `deliver` one into a parent session so it wakes. See [subagents](https://github.com/botiverse/oar/blob/main/docs/spec/subagents.md). Node-only.
- `@botiverse/oar/agents/report`: `formatReport`, `parseReport`, `reportOrigin` and their types, with no Node or adapter imports, for a host forwarding or displaying reports. `parseReport` reads the existing report format into header fields, a structured outcome and the original body, or returns `null`. `@botiverse/oar/agents` loads every built-in runtime, because `createSubagents` defaults to them.
- `@botiverse/oar/testing`: `scriptedRuntime({ turn })`, a ready-made runtime on the kernel SPI whose model is a script. It yields a real `Session` (same records, folds and control semantics) with no binary, login or provider, for hosts' tests and demos. A script can also start tasks (`turn.task`) that end after the turn, like a background command. Node-only.
- `@botiverse/oar/forms`: runtime config forms for a host's agent-creation UI, as plain data (`configForms` and the frozen `baselineForms`, keyed by runtime id; grok only so far) with pure `validateConfig`, `toSessionOptions` and `toModelListing`. A form states what the runtime accepts; a host may only narrow it. Loads no runtime SDK and does nothing on import, so it runs in a browser. See [config form](https://github.com/botiverse/oar/blob/main/docs/spec/config-form.md).

Brand SVG files are exported at `@botiverse/oar/assets/brands/<runtime-id>.svg`. Any other deep import (`@botiverse/oar/dist/...`, source paths) is internal and may break without notice.

Antigravity, CodeBuddy, Grok, Kimi, and OpenCode share an internal ACP v1 transport and session kernel, but only their concrete runtime identities are public. The registry deliberately does not expose a generic `acp` runtime. Pi and Cursor run in the host process through their SDKs. The pi SDK (`@earendil-works/pi-coding-agent`) is a dependency of this package. `@cursor/sdk` is an optional peer dependency, and cursor is not in `defaultRuntimes`: install the SDK (`npm install @cursor/sdk@1.1.0`) and hand it over, `createRuntimeRegistry([...defaultRuntimes.list(), createCursorRuntime({ sdk: () => import("@cursor/sdk") })])`. Written in your code, that import fails your compile if the package is missing. It is Cursor's own package under Cursor's terms, and it signs in with `CURSOR_API_KEY` or its own `Cursor.auth.login()`.

Community runtimes are contributed and maintained outside the core team (each maintainer is named on its runtime page). They ship in this package from a separate entry point, `@botiverse/oar/community`, and are not in `defaultRuntimes`: `createRuntimeRegistry([...defaultRuntimes.list(), createMorphRuntime()])` adds [Mister Morph](https://github.com/botiverse/oar/blob/main/docs/runtimes/morph.md), driven through its Console Runtime API. The `oar` CLI includes them.

**Pi 1.0.3 Azure migration:** Pi renamed its provider from
`azure-openai-responses` to `azure`. Update that prefix in native provider
configuration and `SessionOptions.model`. When resuming an old Azure session,
explicitly pass `model: "azure/<model>"`; without it, Pi can retain the
conversation while selecting a different default model. The opening `model`
event and `Session.model()` report the effective selection. OAR's `^1.4.0`
dependency range includes this upstream update. See the
[migration evidence and limits](https://github.com/botiverse/oar/blob/main/experiments/runtime-version-checks/2026-10-05.md).

The command-line interface is a separate package: `@botiverse/oar-cli`.

`Runtime.execution` is a readonly declaration available before installation or
session open: `"process"`, `"in_process"` or `null` when undeclared (including
Morph). It is independent of the installed version and stays the same after
`withPlacement()`. Pi's subprocess mode declares `"process"`; Pi's SDK, Cursor
and Pi Durable declare `"in_process"`. A host that wants no process sharing uses:

```ts
const selected = runtime.execution === "process" ? runtime.withPlacement("isolated") : runtime;
```

This preserves SDK and undeclared runtime instances. `null` does not promise
isolation; explicit process placement is still refused for those adapters.
`Runtime.placement` is the requested policy, while `Session.placement` reports
the opened session's actual placement. See the
[placement contract](https://github.com/botiverse/oar/blob/main/docs/spec/record-stream.md#placement-and-release).

What a runtime cannot honor is refused, never dropped: `runtime.session()`
rejects with an `UnsupportedOptionError` (`option` names the refused
`SessionOptions` key, the message is the reason), so a host can try and fall
back on it. `runtime.refusedSessionOptions` names the options a runtime
refuses at open, each with the reason, so a host can leave them out before
opening. One key names a value rather than an option: `mcpServerCredentials`,
an `mcpServers` entry carrying `env` or `headers` (below). Some refusals
depend on the value or operation: Kimi and OpenCode
refuse a `resume` in another directory than the session's own (`option:
"cwd"`). See
[refused session options](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#refused-session-options).

A missing resume target rejects with `SessionNotFoundError` on verified native
signals, carrying `sessionId` and a redacted `cause: { method, native }`.
Other failed opens retain their own errors. Missing is scoped to the runtime's
configuration and, for Pi/Grok, the supplied cwd; save and reuse the cwd with
the id. See [missing resume targets](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#missing-resume-targets).
A target the runtime keeps but will not open now rejects with
`SessionUnavailableError`, whose `reason` is `archived` (the user archived it
in their app; OAR never unarchives it) or `in_use` (another process, such as
the user's app, holds it); codex reports both. See
[unavailable resume targets](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#unavailable-resume-targets).

`SessionOptions.name` is the session's display name in the runtime's own UI
(claude, codex and pi; other runtimes refuse it). A new session gets it; a
resume never replaces a name the session has. See
[session name](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#session-name).

`SessionOptions.additionalDirectories` adds native workspace paths, resolved
relative to `cwd`. Claude, Codex, Cursor, Kimi (new sessions only), and
OpenCode v2 support it; other runtimes refuse it. Empty or omitted adds no
override. It keeps the primary `cwd` and does not change the sandbox mode.
Project rules or instruction files in those directories may or may not load:
the option does not guarantee it. Resume and configuration rules differ by runtime; see
[additional directories](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#additional-directories).

`SessionOptions.outputSchema` supplies a JSON Schema object for final output.
Claude and Grok report their native validated value on a completed
`TurnOutcome.structuredOutput`; `promptAndWait`, status and SessionView
preserve it. Codex sends the schema to its provider but returns text only;
OAR never parses or validates that text. Give the schema again on resume.

```ts
import { defaultRuntimes, promptAndWait } from "@botiverse/oar";

const runtime = defaultRuntimes.require("claude");
const installation = await runtime.installation?.();
if (installation?.kind !== "available") throw new Error("Claude unavailable");
const session = await runtime.session(installation, {
  cwd: process.cwd(),
  outputSchema: {
    type: "object", properties: { answer: { type: "integer" } },
    required: ["answer"], additionalProperties: false,
  },
});
try {
  const run = await promptAndWait(session, "What is 2 + 2?");
  if (run.kind !== "rejected" && run.outcome.kind === "completed" && "structuredOutput" in run.outcome) {
    console.log(run.outcome.structuredOutput);
  }
} finally { await session.dispose(); }
```

Even with a schema, Claude may complete without `structuredOutput`; check
the field's presence as well as the outcome. Other core runtimes refuse
`outputSchema` at open. Where each runtime applies the schema, and how it
fails: [structured output](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#structured-output).

`SessionOptions.mcpServers` attaches MCP servers (stdio `{name, command,
args?, env?}` or streamable HTTP `{name, type: "http", url, headers?}`) to
one session, on top of the runtime's own, through each runtime's own channel
(claude reads them from a 0600 FIFO that never puts them on a disk, a
temporary file on Windows); cursor and pi-durable refuse them. Give them
again on `resume`. Their `env` and `headers` values never
appear in a record or an error; antigravity, which would store them in its
conversation database, refuses an entry carrying them (declared as
`mcpServerCredentials`; leave such entries out). Every runtime refuses the
names `__proto__`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`
and `__lookupSetter__` (`option: "mcpServers"`), which some runtimes drop
without a word. See the
[channels](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#refused-session-options)
and each runtime page's "Session MCP servers".

Tools the host implements itself go through the same option. `serveMcpTools`
serves them from an MCP server inside the host process and returns the
`mcpServers` entry to pass, so one implementation reaches every runtime that
takes an http entry with `headers` (all but cursor, pi-durable and antigravity):

```ts
import { serveMcpTools } from "@botiverse/oar";

const served = await serveMcpTools({
  name: "workspace",
  tools: [{
    name: "read_note",
    description: "Read a note from the host's store",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async ({ id }, { signal }) => await notes.read(String(id), { signal }),
  }],
});
const session = await runtime.session(installation, { cwd, mcpServers: [served.server] });
// ... later, after the sessions that use it are disposed:
await served.close();
```

It listens on 127.0.0.1 behind a random bearer token (in the entry's
`headers`, so it never appears in a record), so the runtime must run on this
machine, as OAR's runtimes do. A handler returns text, or MCP content with
`isError` for a failed call; a thrown error becomes an `isError` result with
its message. Its `signal` aborts when the runtime cancels the call or the
server closes. One served set can back several sessions. `instructions` (guidance
across the tools) goes out as the MCP server instructions; claude, codex,
opencode and grok show them to the model, pi and kimi do not.
`served.setTools(tools)` replaces the tools while sessions run and sends MCP's
`notifications/tools/list_changed`. Whether a running session's model sees
the change is the runtime's choice, declared before opening as
`runtime.mcpToolsListChanged`: `full` (pi, opencode), `additions` (claude:
new tools appear, removed ones stay offered) or `none` (codex, kimi, grok); a
session that does not take it gets the new tools when the host opens its next
session. The declaration covers any MCP server that announces a change, so
antigravity declares `full` too, though a served entry never attaches there. See
[host-served tools](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#host-served-tools).

`runtime.listModels(installation, options?)` lists the models an installation
can run now (`ok`, `unauthenticated` or `unsupported`); every built-in runtime
has it. Entries include native `effortLevels` and `serviceTiers` where supported.
`default: true` marks the model a session uses when no `model` is set, where
the runtime says so (codex's configured model, else its catalog default; a new
session's current model on grok, kimi and antigravity; the default saved in
pi's settings). claude, cursor and opencode mark none: OAR never picks one.
Where several providers serve models (pi, opencode), `provider: { id,
displayName? }` says which, so a host never parses `id`. A project's own
configuration can change the list and its default, so pass `options.cwd`, the
directory a session would run in (the host's cwd by default). Like the
inventory readers, listing starts the runtime there the way a session would
and can run that workspace's code (pi loads the project's extensions), so do
not list in a directory you do not trust.
`SessionOptions.serviceTier` applies at open (also on resume) and is checked
against the runtime's own report. Use `default` to explicitly clear a tier;
it is not a model catalog entry. `Session.serviceTier()` reports the effective
tier. Unsupported runtimes reject the option before opening.
`runtime.accountUsage(installation)` reads account quota on claude,
codex, grok and kimi; its failure semantics are in the
[account usage reference](https://github.com/botiverse/oar/blob/main/docs/spec/account-usage.md).

`runtime.checkUpdate(installation)` reports the version the runtime's own
updater would install and where that answer came from;
`runtime.upgrade(installation)` runs that updater without a terminal and
judges the result by the version the same executable reports afterwards,
never by its exit code. oar never upgrades on its own. Claude, Codex, Grok
and Kimi have both; Antigravity has only the check; OpenCode has neither
yet; Pi and Cursor have neither, their SDK versions following oar's (Pi's
SDK is a dependency, Cursor's an exact peer dependency).
See [runtime updates](https://github.com/botiverse/oar/blob/main/docs/spec/update.md).

`runtime.installPlan()` reports what installing a runtime would run on this
machine (the vendor's documented installer and the page that documents it)
or why it would run no installer (`platform`, `requires_privileges`,
`requires_gui`, `missing_tool`, `location_unknown`; `requires_privileges`, `missing_tool` and `location_unknown`
still carry the vendor's `steps` and `source`, for the person to run
themselves once they have the rights or the tool, or have checked the installer's
location configuration); `runtime.install()` runs
it, without a terminal and never with sudo, when `installation()` finds no
copy, and judges the result by `installation()` afterwards, never by the
installer's exit code. oar never installs on its own. Claude, Codex, Grok,
Kimi and OpenCode install through their vendors' macOS and Linux scripts;
CodeBuddy uses its official npm package on Linux, macOS and Windows, checks
the configured global prefix, and discovers its launcher even off PATH.
Planning may run bounded local read-only queries with private temporary files
removed afterwards; it never installs, downloads packages or changes user files.
An unreadable prefix returns `location_unknown` with the failure category in
`detail`, without npm's raw output.
OpenCode declares two release lines in `runtime.installLines` (`v1`, `v2`)
and takes the host's choice as `line` (oar picks none), and a copy of either
line is `already_installed`, never replaced. Antigravity's plan is
`requires_gui`; Pi and Cursor have neither member.
See [runtime install](https://github.com/botiverse/oar/blob/main/docs/spec/install.md).

`runtime.login(installation, interaction)` logs an installation in through
the runtime's own login, without a terminal: the sign-in URL or device code
arrives as a `ProviderLoginInteraction` event, and a code the person pastes
back is answered through its `manual_code` prompt and written to the
runtime's stdin only. It never logs the current account out first, and
`interaction.signal` cancels it. `runtime.authStatus(installation)` reads the
runtime's own status, never a secret, and never starts a login. Claude,
Codex, Cursor (through its SDK's own `Cursor.auth`), Qoder and Kimi (`kimi
login`, with `KimiLoginOptions.region`) have both. Qwen has only
`authStatus`, a local check of whether a provider credential is configured;
its provider settings are on `createQwenProviderAuth`. Grok, OpenCode and Pi
have neither yet (Pi's provider logins are on `createPiProviderAuth`).
CodeBuddy supports login and a private native account-state read, but no logout
([mapping](../../docs/runtimes/codebuddy.md#international-login)).
Antigravity has neither, since its terms do not allow signing in through a
third-party tool. `runtime.logout(installation)` signs Claude, Codex, Cursor
and Kimi out through their own logout (`claude auth logout`, `codex logout`,
`Cursor.auth.logout`, Kimi's ACP `logout`) and resolves `logged_out` when
`authStatus` then reads logged out (or, when it cannot tell, on the
runtime's own report of success); an API key in the environment is not
touched, and one the status still reads is `failed` / `still_logged_in`.
See
[runtime login](https://github.com/botiverse/oar/blob/main/docs/spec/login.md).

Images go with an input through `InputOptions.images` (`{ path }` entries:
absolute paths to png, jpeg, gif or webp files) on prompt, steer and queue,
as the runtime's own image content. `session.capabilities.images` says whether
the runtime takes them; an input it cannot deliver is rejected whole. See
[Images](https://github.com/botiverse/oar/blob/main/docs/spec/conversation.md#images).

TypeScript hosts: keep `skipLibCheck` on. With `skipLibCheck: false` and `module: nodenext`, importing `@botiverse/oar` alone reports errors inside the pi SDK's declarations and their dependencies' (`@earendil-works/pi-ai` imports JSON without an import attribute, TS1543; its `@google/genai` imports the optional peer `@modelcontextprotocol/sdk`, TS2307, and without the DOM lib also misses `RequestInfo` and `HeadersInit`); OAR's own declarations check clean (official TypeScript 6.0.3 consuming a clean install of the tsrs-built package, 2026-10-26). A host that installs `@cursor/sdk` and checks library files also needs the DOM lib for its `@connectrpc/connect` dependency (`HeadersInit`).

## Host-owned durable sessions

Install the optional native peers in the host: `npm install @earendil-works/pi-durable@~1.4.0 @earendil-works/chord@~1.4.0`.
Upgrade both together. Native 1.4.0 migrates SQLite storage to schema 2,
which cannot be reopened by 1.3.0 or earlier; see the
[host upgrade notes](https://github.com/botiverse/oar/blob/main/docs/runtimes/pi-durable.md#native-objects-and-calling-interface)
for storage and extension API changes.
The factory lives only in `@botiverse/oar/pi-durable`, usable in Node and browsers.
The root and browser core entries load without these peers.

```ts
import { viewOf } from "@botiverse/oar/browser";
import { createPiDurableRuntime } from "@botiverse/oar/pi-durable";

// Use the same Models instance or () => Models supplier passed to Harness.open.
const runtime = createPiDurableRuntime({ harness, models });
const session = await runtime.session({ kind: "available", via: "bundled" }, {
  cwd: "/workspace", model: "provider/model",
});
session.rawEvents(() => render(viewOf(session.records())));
await session.prompt("Hello", { inputId: crypto.randomUUID() });
```

The host owns its Pi Durable 1.4.0 Harness, providers, credentials, extensions
and storage. `resume: session.id` attaches to that storage's conversation and
resumes unfinished work. Queue and input-id deduplication are native and
durable. `dispose()` detaches the observer; it does not stop work or close the
Harness. Use `abort()` to stop a run. The portable entry needs Web Crypto.
See [Pi Durable](https://github.com/botiverse/oar/blob/main/docs/runtimes/pi-durable.md)
for configuration, snapshot and recovery semantics. This constructor is not
in the default registry or CLI.

## Native inventories

Every runtime exposes `skills(installation, options?)`,
`commands(installation, options?)`, `mcpServers(installation, options?)`, and `tools(installation, options?)`.
Options are `{ cwd?: string, timeoutMs?: number }`; cwd defaults to
`process.cwd()`. Queries discover native information independently: they do
not inspect an existing Session or submit a model prompt, though native
startup can load extensions and connect configured MCP servers.

Results distinguish `ok`, `unsupported`, and `unavailable`. Successful results
contain `items`, `scope.cwd`, `observedAt`, `view`, and `partial`. A
`mcp-only` view excludes built-in tools. Unknown schema or state fields stay
absent, and an unsupported query never pretends to be an empty catalog.

Codex and Claude expose skills and MCP discovery (tools are MCP-only); Grok
exposes independent skills and MCP configuration discovery; Pi exposes skills
and registered tools with active membership. Pi commands include extension
commands and prompt templates; Claude commands come from native initialize.
Other core runtimes return unsupported for independent command discovery.
Antigravity, Cursor, Kimi and
OpenCode inventory queries are unsupported.

```ts
const catalog = await runtime.commands(installation, { cwd: "/my/project" });
if (catalog.kind === "ok") {
  for (const command of catalog.items) {
    console.log(command.name, command.description, command.argumentHint);
  }
}
```

Command entries use native invocation names (Pi resolves duplicate extension
names itself), with optional source and aliases. Skills stay in `skills()`;
hosts merge catalogs for a picker. Claude's native catalogs can overlap.
This is discovery, not execution or a live session's command state.
[Command scope and limits](https://github.com/botiverse/oar/blob/main/docs/spec/inventory.md#commands).

Custom runtimes should use `defineRuntime`, which fills missing inventory
methods with explicit unsupported results and supplies `execution`, `placement`
and `withPlacement`. Its second argument's `execution` controls both the public
declaration and placement selection; omission gives `null`. Supplying `shared`
hooks requires `execution: "process"`, checked by the type and at runtime.
A manually constructed `Runtime` must implement the four inventory methods, including
`commands`, and these placement members.

### Orientation

`orient(registry, { depth: "local" | "account" | "models", runtimes?, timeoutMs?, signal? })`
combines existing readers into timestamped probes, preserving missing and failed
evidence. Local is the default and skips auth readers without a proven local
query. Account reads can refresh credentials or execute configured key commands;
models can start native processes and run trusted configuration.
`include: ["customization"]` explicitly opts into native inventory counts.
`usability(snapshot, { minVersions? })` is a pure, browser-safe readiness
projection from `@botiverse/oar/observe`. Hosts own freshness and selection.
See [orientation](https://github.com/botiverse/oar/blob/main/docs/spec/orientation.md).

### Runtime branding

`runtime.brand` contains `{ name, icon }`. Built-in icons are self-contained SVG
data URIs, usable as an `<img src>` offline and serializable across IPC.
Reading branding needs no installation, login, or runtime process. Browser-only
consumers can read it without loading native SDKs:

```ts
import { runtimeBrands } from "@botiverse/oar/brands";
const { name, icon } = runtimeBrands.claude;
```

The SVG files' attribution and licenses ship in `assets/brands/NOTICE.md`; Pi
uses the official `pi.dev` logo assets. Custom runtimes created with
`defineRuntime` may supply `brand`; otherwise it defaults to
`{ name: runtime.id, icon: null }`. Runtime branding identifies the provider
and is independent of an application's project avatars.

`brand.icons?.light` and `brand.icons?.dark` optionally override the default
for light and dark **backgrounds**; they need not be distinct or both present.
`runtimeBrandIcon(brand, theme)` returns the matching variant, falling back to
`brand.icon` (null for brands without artwork). Hosts choose the theme from
their own surface, not necessarily the operating system setting.

```ts
import { runtimeBrands, runtimeBrandIcon } from "@botiverse/oar/brands";
const src = runtimeBrandIcon(runtimeBrands.codex, "dark");
```

Qwen Code is available as `qwenRuntime` and in `defaultRuntimes`. Install
`@qwen-code/qwen-code` separately. The async `createQwenProviderAuth(installation,
{ cwd?, env?, timeoutMs? })` factory exposes native provider `listProviders()`
and `connect()` operations; environment-based provider configuration also works.
Its `existingConfig` is settings metadata, and connect success confirms a
configuration write, not remote credential validity. Qwen owns the write scope.
It uses stream-json with a held, withdrawable queue and no steer. Structured
output, images, service tier and name are refused; resumed token totals remain
unknown without a native baseline. See its [runtime mapping](https://github.com/botiverse/oar/blob/main/docs/runtimes/qwen.md),
including the cold HOME startup restriction for concurrent sessions.
