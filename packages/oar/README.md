# @botiverse/oar

Provider-independent TypeScript contracts and built-in implementations for controlling and observing Antigravity, Claude, Codex, Cursor, Grok, Kimi, OpenCode, Pi, and Pi Durable.

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
runtime's own frames.

`session.deliver(input, { when, origin })` sends input the host produces (a
subagent's result, a finished job) at the right moment: a new turn when the
session is idle, so the agent wakes, otherwise steered into the turn or queued
behind it. `origin` is recorded so a UI can tell it from typed input.
`session.steer` exists only on a session whose runtime can steer (kimi and
antigravity sessions have none), so a host offers a steer control by reading
the member, never a runtime name; `deliver` and `steerOrQueue` queue where it
is absent. `session.withdraw(inputId)` takes a queued input back before it is
sent (`accepted`), or answers `not_queued` once it went; with it a UI offers
withdraw, edit (withdraw, then `queue` again) and send now (withdraw, then
`deliver`). It exists where OAR holds the queue itself (claude, pi, cursor
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

The package has these public entry points, plus `@botiverse/oar/community` for community runtimes (below):

- `@botiverse/oar`: the runtime registry and adapters, `defineRuntime`, `UnsupportedOptionError`, `RuntimeFailureError`, the `oar-voyage/3` recorder (`openVoyage`), and everything the brands and observe entry points below export. Node-only (adapters import `node:child_process` and runtime SDKs).
- `@botiverse/oar/browser`: portable contracts, registry, session kernel, observe helpers, agent report formatting, and branding. No Node adapters, process helpers or local image-file loaders.
- `@botiverse/oar/brands`: browser-safe runtime names and SVG icons.
- `@botiverse/oar/observe`: the browser-safe pure derivations over `RawEvent`s and `Event`s (`eventsOf`, `coalesceText`, `observeAgent`, `reduceStatus`, `tasksOf`, `observeStalls`, `classifyTool`, `reduceConversation`, `viewOf`, …) with no Node or adapter imports, so a browser or Electron-renderer bundle can import it directly. The root export re-exports all of them.
  It also supplies `failureAdvice` (recovery timing per `FailureClass`) and `noticeText`, `noticeTone`, `phaseLabel`, `failureText` and `taskStatusLabel`, alongside `toolActionLabel` and `toolGroupSummary`: English display wording for OAR types, usable in JavaScriptCore too. Wording may change in a minor release; hosts must use the typed values for decisions, not parse the text ([display wording](https://github.com/botiverse/oar/blob/main/docs/spec/conversation.md#display-wording)).
- `@botiverse/oar/kernel`: the runtime-author SPI. `createSessionKernel` is the record stream every built-in adapter is built on (dense `seq`, cursor replay, control recording, the reachability rule) and `sealSession` derives the `Session` API face over an adapter. Pair with `defineRuntime` to ship a custom runtime (a scripted runtime for a host's tests, an in-process agent) without re-implementing the stream contract. `inputImagesRefusal` and `withInputImages` are the image rules every built-in runtime keeps, so a custom runtime refuses the inputs they refuse. `withdrawHeld` is the decision behind `withdraw` for a runtime that holds its own queue.
- `@botiverse/oar/agents`: subagents. `createSubagents()` starts child sessions on any runtime that takes `SessionOptions.env` (not cursor), returns a report for every turn they end, takes follow-ups, enforces depth and concurrency limits, and reports each child as a task. The host takes reports with `wait` / `next` or receives them through an `onReport` hook; with `formatReport` and `reportOrigin` it can `deliver` one into a parent session so it wakes. See [subagents](https://github.com/botiverse/oar/blob/main/docs/spec/subagents.md). Node-only.
- `@botiverse/oar/agents/report`: `formatReport`, `parseReport`, `reportOrigin` and their types, with no Node or adapter imports, for a host forwarding or displaying reports. `parseReport` reads the existing report format into header fields, a structured outcome and the original body, or returns `null`. `@botiverse/oar/agents` loads every built-in runtime, because `createSubagents` defaults to them.
- `@botiverse/oar/testing`: `scriptedRuntime({ turn })`, a ready-made runtime on the kernel SPI whose model is a script. It yields a real `Session` (same records, folds and control semantics) with no binary, login or provider, for hosts' tests and demos. A script can also start tasks (`turn.task`) that end after the turn, like a background command. Node-only.

Brand SVG files are exported at `@botiverse/oar/assets/brands/<runtime-id>.svg`. Any other deep import (`@botiverse/oar/dist/...`, source paths) is internal and may break without notice.

Antigravity, Grok, Kimi, and OpenCode share an internal ACP v1 transport and session kernel, but only their concrete runtime identities are public. The registry deliberately does not expose a generic `acp` runtime. Pi and Cursor run in the host process through their SDKs. The pi SDK (`@earendil-works/pi-coding-agent`) is a dependency of this package. `@cursor/sdk` is an optional peer dependency, and cursor is not in `defaultRuntimes`: install the SDK (`npm install @cursor/sdk@1.0.37`) and hand it over, `createRuntimeRegistry([...defaultRuntimes.list(), createCursorRuntime({ sdk: () => import("@cursor/sdk") })])`. Written in your code, that import fails your compile if the package is missing. It is Cursor's own package under Cursor's terms, and it signs in with `CURSOR_API_KEY` or its own `Cursor.auth.login()`.

Community runtimes are contributed and maintained outside the core team (each maintainer is named on its runtime page). They ship in this package from a separate entry point, `@botiverse/oar/community`, and are not in `defaultRuntimes`: `createRuntimeRegistry([...defaultRuntimes.list(), createMorphRuntime()])` adds [Mister Morph](https://github.com/botiverse/oar/blob/main/docs/runtimes/morph.md), driven through its Console Runtime API. The `oar` CLI includes them.

**Pi 1.0.3 Azure migration:** Pi renamed its provider from
`azure-openai-responses` to `azure`. Update that prefix in native provider
configuration and `SessionOptions.model`. When resuming an old Azure session,
explicitly pass `model: "azure/<model>"`; without it, Pi can retain the
conversation while selecting a different default model. The opening `model`
event and `Session.model()` report the effective selection. OAR's `^1.0.2`
dependency range already permits this upstream update. See the
[migration evidence and limits](https://github.com/botiverse/oar/blob/main/experiments/runtime-version-checks/2026-10-05.md).

The command-line interface is a separate package: `@botiverse/oar-cli`.

What a runtime cannot honor is refused, never dropped: `runtime.session()`
rejects with an `UnsupportedOptionError` (`option` names the refused
`SessionOptions` key, the message is the reason), so a host can try and fall
back on it. `runtime.refusedSessionOptions` names the options a runtime
refuses at open (`systemPrompt`, `appendSystemPrompt`, `env`, `mcpServers`),
each with the reason, so a host can leave them out before opening: cursor
refuses all four, kimi, antigravity and opencode the two prompt options. Kimi and
opencode also refuse a `resume` in another directory than the session's own
(`option: "cwd"`). See
[refused session options](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#refused-session-options).

`SessionOptions.mcpServers` attaches MCP servers (stdio `{name, command,
args?, env?}` or streamable HTTP `{name, type: "http", url, headers?}`) to
one session, on top of the runtime's own: claude reads them from a 0600
FIFO that never puts them on a disk (a temporary file on Windows), codex
from its thread config overrides, grok, kimi, opencode and antigravity from
ACP `session/new` / `session/resume`, pi from an extension that registers
them; cursor and pi-durable refuse them. Give them again on `resume`. Their `env` and `headers` values never
appear in a record or an error; antigravity, which would store them in its
conversation database, refuses an entry carrying them. See the
[channels](https://github.com/botiverse/oar/blob/main/docs/spec/runtime-matrix.md#refused-session-options)
and each runtime page's "Session MCP servers".

`runtime.listModels(installation, options?)` lists the models an installation
can run now (`ok`, `unauthenticated` or `unsupported`); every built-in runtime
has it. Entries include native `effortLevels` and `serviceTiers` where supported.
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
or why it would run nothing (`platform`, `requires_privileges`,
`requires_gui`, `missing_tool`); `runtime.install()` runs it, without a
terminal and never with sudo, when `installation()` finds no copy, and
judges the result by `installation()` afterwards, never by the installer's
exit code. oar never installs on its own. Claude, Codex, Grok, Kimi and
OpenCode install through their vendors' macOS and Linux scripts; OpenCode
declares two release lines in `runtime.installLines` (`v1`, `v2`) and takes
the host's choice as `line` (oar picks none), and a copy of either line is
`already_installed`, never replaced. Antigravity's plan is `requires_gui`;
Pi and Cursor have neither member.
See [runtime install](https://github.com/botiverse/oar/blob/main/docs/spec/install.md).

`runtime.login(installation, interaction)` logs an installation in through
the runtime's own login, without a terminal: the sign-in URL or device code
arrives as a `ProviderLoginInteraction` event, and a code the person pastes
back is answered through its `manual_code` prompt and written to the
runtime's stdin only. It never logs the current account out first, and
`interaction.signal` cancels it. `runtime.authStatus(installation)` reads the
runtime's local status query. Claude, Codex and Cursor (through its SDK's
own `Cursor.auth`) have both; Antigravity has neither, since its terms do not
allow signing in through a third-party tool. `runtime.logout(installation)`
signs those three out through their own logout (`claude auth logout`,
`codex logout`, `Cursor.auth.logout`) and resolves `logged_out` when
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

TypeScript hosts: keep `skipLibCheck` on. With `skipLibCheck: false` and `module: nodenext`, importing `@botiverse/oar` alone reports errors inside the pi SDK's own declarations (`@earendil-works/pi-ai` imports JSON without an import attribute, TS1543); OAR's own declarations check clean. A host that installs `@cursor/sdk` and checks library files also needs the DOM lib for its `@connectrpc/connect` dependency (`HeadersInit`).

## Host-owned durable sessions

Install the optional native peers in the host: `npm install @earendil-works/pi-durable@~1.1.0 @earendil-works/chord@~1.1.0`.
The factory lives only in `@botiverse/oar/pi-durable`, usable in Node and browsers.
The root and browser core entries load without these peers.

```ts
import { viewOf } from "@botiverse/oar/browser";
import { createPiDurableRuntime } from "@botiverse/oar/pi-durable";

// Use the same Models instance that the host passed to Harness.open.
const runtime = createPiDurableRuntime({ harness, models });
const session = await runtime.session({ kind: "available", via: "bundled" }, {
  cwd: "/workspace", model: "provider/model",
});
session.rawEvents(() => render(viewOf(session.records())));
await session.prompt("Hello", { inputId: crypto.randomUUID() });
```

The host owns its Pi Durable 1.1.0 Harness, providers, credentials, extensions
and storage. `resume: session.id` attaches to that storage's conversation and
resumes unfinished work. Queue and input-id deduplication are native and
durable. `dispose()` detaches the observer; it does not stop work or close the
Harness. Use `abort()` to stop a run. The portable entry needs Web Crypto.
See [Pi Durable](https://github.com/botiverse/oar/blob/main/docs/runtimes/pi-durable.md)
for configuration, snapshot and recovery semantics. This constructor is not
in the default registry or CLI.

## Native inventories

Every runtime exposes `skills(installation, options?)`,
`mcpServers(installation, options?)`, and `tools(installation, options?)`.
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
and registered tools with active membership. Antigravity, Cursor, Kimi and
OpenCode inventory queries are unsupported.

Custom runtimes should use `defineRuntime`, which fills missing inventory
methods with explicit unsupported results. A manually constructed `Runtime`
must implement the three methods.

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
