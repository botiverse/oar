# @botiverse/oar

Provider-independent TypeScript contracts and built-in implementations for controlling and observing Antigravity, Claude, Codex, Cursor, Grok, Kimi, and Pi.

```ts
import { promptAndWait, runtimes } from "@botiverse/oar";

const runtime = runtimes.require("grok");
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
echoes, text, reasoning, tool call start / progress / end, turn start and end,
usage, model, effort, compaction start / end, retry, background tasks and
subagents started, updated and ended, runtime→app requests and oar's answers,
control rejections, the process exit), each carrying the `seq`
and `agentPath` of the record it was read from. Kinds a runtime never says
(claude has no compaction start, ACP runtimes no compaction, only pi says
retry) simply never appear; the runtime pages say which. It is a projection over the record stream: `session.rawEvents()`
and `session.records()` expose that stream (`RawEvent`: `Frame` with the
native payload verbatim, `RequestRecord`, `ResponseRecord`) for consumers
who need the runtime's own frames.

For conversation UIs, use the browser-safe `reduceConversation` projection over
`session.rawEvents()`. It joins input requests, responses and native echoes by
identity, including steer → queue fallback. See the
[conversation contract](https://github.com/botiverse/oar/blob/main/docs/spec/conversation.md).

## Public exports

The package has six public entry points:

- `@botiverse/oar`: the full surface (runtime registry, adapters, and everything below). Node-only (adapters import `node:child_process` and runtime SDKs).
- `@botiverse/oar/brands`: browser-safe runtime names and SVG icons.
- `@botiverse/oar/observe`: browser-safe subset, the pure derivation utilities over `RawEvent`s and `Event`s (`eventsOf`, `coalesceText`, `observeAgent`, `reduceStatus`, `tasksOf`, `observeStalls`, `classifyTool`, …) with zero Node and zero adapter imports. A browser or Electron-renderer bundle can import this subpath directly without dragging Node-only modules in. The root export re-exports the same utilities for Node consumers.
- `@botiverse/oar/kernel`: the runtime-author SPI. `createSessionKernel` is the record stream every built-in adapter is built on (dense `seq`, cursor replay, control recording, the reachability rule) and `sealSession` derives the `Session` API face over an adapter. Pair with `defineRuntime` to ship a custom runtime (a scripted runtime for a host's tests, an in-process agent) without re-implementing the stream contract. `inputImagesRefusal` and `withInputImages` are the image rules every built-in runtime keeps, so a custom runtime refuses the inputs they refuse.
- `@botiverse/oar/agents`: subagents. `createSubagents()` starts child sessions on any runtime, returns a report for every turn they end, takes follow-ups, enforces depth and concurrency limits, reports each child as a task, and can deliver reports into a parent session so it wakes. See [subagents](https://github.com/botiverse/oar/blob/main/docs/spec/subagents.md). Node-only.
- `@botiverse/oar/testing`: `scriptedRuntime({ turn })`, a ready-made runtime on the kernel SPI whose model is a script. It yields a real `Session` (same records, folds and control semantics) with no binary, login or provider, for hosts' tests and demos. Node-only.

Any other deep import (`@botiverse/oar/dist/...`, source paths) is internal and may break without notice.

Antigravity, Cursor, Grok, and Kimi share an internal ACP v1 transport and session kernel, but only their concrete runtime identities are public. The registry deliberately does not expose a generic `acp` runtime.

The command-line interface is a separate package: `@botiverse/oar-cli`.

`runtime.listModels(installation, options?)` lists the models an installation
can run now (`ok`, `unauthenticated` or `unsupported`); every built-in runtime
has it. `runtime.accountUsage(installation)` reads account quota on claude,
codex, grok and kimi; its failure semantics are documented in the
[account usage reference](https://github.com/botiverse/oar/blob/main/docs/spec/account-usage.md).

`runtime.checkUpdate(installation)` reports the version the runtime's own
updater would install and where that answer came from;
`runtime.upgrade(installation)` runs that updater without a terminal and
judges the result by the version the same executable reports afterwards,
never by its exit code. oar never upgrades on its own. Claude, Codex, Cursor,
Grok and Kimi have both; Antigravity has only the check; Pi moves with oar.
See [runtime updates](https://github.com/botiverse/oar/blob/main/docs/spec/update.md).

Images go with an input through `InputOptions.images` (absolute paths to png,
jpeg, gif or webp files) on prompt, steer and queue, as the runtime's own image
content. `session.capabilities.images` says whether the runtime takes them; an
input it cannot deliver is rejected whole. See
[Images](https://github.com/botiverse/oar/blob/main/docs/spec/conversation.md#images).

## Native inventories

Every runtime exposes `skills(installation, options?)`,
`mcpServers(installation, options?)`, and `tools(installation, options?)`.
Options are `{ cwd?: string, timeoutMs?: number }`; cwd defaults to
`process.cwd()`. Queries independently discover native information and do not
inspect an existing Session or submit a model prompt.

Results distinguish `ok`, `unsupported`, and `unavailable`. Successful results
contain `items`, `scope.cwd`, `observedAt`, `view`, and `partial`. A
`mcp-only` view excludes built-in tools. Unknown schema or state fields stay
absent, and an unsupported query never pretends to be an empty catalog.

Codex and Claude expose skills and MCP discovery (tools are MCP-only); Grok
exposes independent skills/MCP configuration discovery; Pi exposes skills and
registered tools with active membership. Antigravity, Cursor and Kimi
inventory queries are unsupported. Native startup can load extensions and connect configured
MCP servers.

Custom runtimes should use `defineRuntime`, which fills unavailable inventory
methods with explicit unsupported results. A manually constructed `Runtime`
must implement the three methods.

### Runtime branding

`runtime.brand` contains `{ name, icon }`. Built-in icons are self-contained SVG
data URIs, usable as an `<img src>` offline and serializable across IPC. No
installation, login, or runtime process is needed to read branding.

For browser-only consumers (without loading native SDKs):

```ts
import { runtimeBrands } from "@botiverse/oar/brands";
const { name, icon } = runtimeBrands.claude;
```

SVG files are also exported at `@botiverse/oar/assets/brands/<runtime-id>.svg`.
Their attribution and licenses ship in `assets/brands/NOTICE.md`. Pi uses the official `pi.dev` logo assets.
Custom runtimes created with `defineRuntime` may supply `brand`; otherwise it
defaults to `{ name: runtime.id, icon: null }`. Runtime branding identifies the
provider and is independent of an application's project avatars.

`brand.icons?.light` and `brand.icons?.dark` optionally override the default for
light and dark **backgrounds**. They are not required to be distinct or both
present. `runtimeBrandIcon(brand, theme)` returns the matching variant, falling
back to `brand.icon` (including null for brands without artwork). Hosts choose
the theme from their own surface, not necessarily the operating system setting.

```ts
import { runtimeBrands, runtimeBrandIcon } from "@botiverse/oar/brands";
const src = runtimeBrandIcon(runtimeBrands.codex, "dark");
```
