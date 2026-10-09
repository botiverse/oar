# OAR - *programming interface for all agent harnesses*

<div align="center">
  <img src="assets/logo.png" alt="OAR logo" width="120">
</div>

OAR (**O**pen **A**gent **R**untime) is a provider-independent programming interface for coding-agent runtimes: a solid foundation for building agent workspaces and other applications.

**Delete harness logic and focus on outcomes and UX.**

## Supported runtimes

<table>
  <tr>
    <td align="center" width="112">
      <a href="docs/runtimes/antigravity.md">
        <img src="packages/oar/assets/brands/antigravity.svg" width="32" height="32" alt=""><br>
        Antigravity
      </a>
    </td>
    <td align="center" width="112">
      <a href="docs/runtimes/claude.md">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/oar/assets/brands/claude.svg">
          <img src="packages/oar/assets/brands/claude.svg" width="32" height="32" alt="">
        </picture><br>
        Claude Code
      </a>
    </td>
    <td align="center" width="112">
      <a href="docs/runtimes/codex.md">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/oar/assets/brands/codex-on-dark.svg">
          <img src="packages/oar/assets/brands/codex-on-light.svg" width="32" height="32" alt="">
        </picture><br>
        Codex
      </a>
    </td>
    <td align="center" width="112">
      <a href="docs/runtimes/cursor.md">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/oar/assets/brands/cursor-on-dark.svg">
          <img src="packages/oar/assets/brands/cursor-on-light.svg" width="32" height="32" alt="">
        </picture><br>
        Cursor
      </a>
    </td>
    <td align="center" width="112">
      <a href="docs/runtimes/grok.md">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/oar/assets/brands/grok-on-dark.svg">
          <img src="packages/oar/assets/brands/grok-on-light.svg" width="32" height="32" alt="">
        </picture><br>
        Grok Build
      </a>
    </td>
    <td align="center" width="112">
      <a href="docs/runtimes/kimi.md">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/oar/assets/brands/kimi-on-dark.svg">
          <img src="packages/oar/assets/brands/kimi-on-light.svg" width="32" height="32" alt="">
        </picture><br>
        Kimi Code
      </a>
    </td>
    <td align="center" width="112">
      <a href="docs/runtimes/opencode.md">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/oar/assets/brands/opencode-on-dark.svg">
          <img src="packages/oar/assets/brands/opencode-on-light.svg" width="32" height="32" alt="">
        </picture><br>
        OpenCode
      </a>
    </td>
    <td align="center" width="112">
      <a href="docs/runtimes/pi.md">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="packages/oar/assets/brands/pi-on-dark.svg">
          <img src="packages/oar/assets/brands/pi-on-light.svg" width="32" height="32" alt="">
        </picture><br>
        Pi
      </a>
    </td>
  </tr>
</table>

[Pi Durable](docs/runtimes/pi-durable.md) also runs through a host-owned Harness,
including in a browser via `@botiverse/oar/pi-durable` and the portable
core in `@botiverse/oar/browser`. The host installs its optional native peers.
Try the [browser demo](apps/pi-durable/README.md) with `pnpm durable-demo`.

## Library

One API drives every runtime: swap `"claude"` for `"codex"`, `"grok"` or
`"pi"` (with a model it has) and the code stays the same. An option a
runtime cannot honor is refused before anything opens, never silently
dropped.

```ts
import { defaultRuntimes, promptAndWait } from "@botiverse/oar";

const claude = defaultRuntimes.require("claude");
const installation = await claude.installation?.();
if (installation?.kind !== "available") throw new Error("claude is not installed");

const session = await claude.session(installation, {
  cwd: process.cwd(),
  model: "sonnet",
  effort: "high",
  appendSystemPrompt: "Run the tests before you say you are done.",
  mcpServers: [{ name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }],
});

session.events((event) => {
  // Every event says which agent it came from: [] is the root, a subagent has its own path.
  const who = event.agentPath.length === 0 ? "" : `[${event.agentPath.join(" > ")}] `;
  switch (event.kind) {
    case "text_delta": if (who === "") process.stdout.write(event.text); break;
    case "tool_call_started": console.log(`${who}${event.tool}`); break;
    case "turn_ended": console.log(`${who}${event.outcome.kind}`); break;
  }
});

const run = promptAndWait(session, "Find and fix the flaky test", { timeoutMs: 600_000 });
// Meanwhile, from your UI: steers the running turn, or queues it where the runtime cannot steer.
await session.deliver("Leave the snapshots alone.");
console.log(await run);
console.log(session.status().value, session.usage().value.total, session.contextUsage().value);
await session.dispose();

// Later, even from another process: the same conversation, picked up where it stopped.
const resumed = await claude.session(installation, { cwd: process.cwd(), resume: session.id });
```

Hand work to other runtimes as subagents; each report wakes the session
that is waiting for it:

```ts
import { createSubagents, formatReport, reportOrigin } from "@botiverse/oar/agents";

const crew = createSubagents({ maxRunning: 4 });
crew.onReport((report) => {
  void resumed.deliver(formatReport(report), { origin: reportOrigin(report) });
});
await crew.spawn({ runtime: "codex", task: "Review the diff on this branch for race conditions" });
await crew.spawn({ runtime: "pi", task: "Write the changelog entry for this branch" });
```

What else a session gives you:

- **Every fact, attributed.** `events()` is one `Event` per fact (native user
  message echoes, text, reasoning, tool calls with their later input,
  progress and end, background tasks, turns, usage, model, effort,
  compaction, retries, app requests, control rejections, the process exit),
  each with `seq` and `agentPath`. `{ coalesceText: true }` gives text in
  blocks. `rawEvents()` and `records()` keep every native payload verbatim.
- **Control with honest answers.** `prompt`, `steer`, `queue`, `withdraw`
  and `abort` each answer accepted or rejected with a typed code (`busy`,
  `no_active_turn`, `runtime_exited`, …); where input landed is read from
  the events, never guessed.
- **Projections for UIs.** `@botiverse/oar/observe` folds records into a
  conversation (`reduceConversation`, `viewOf`), status, tasks and stalls,
  with no Node imports, so it runs in a browser.
- **Recording and tests.** `openVoyage` writes a session's records to a
  JSONL log as they happen, so the same folds can read it back later, and
  `@botiverse/oar/testing` gives a scripted runtime with real `Session`
  semantics and no binary or login.

The [package README](packages/oar/README.md) lists the public entry points.
`defaultRuntimes` holds the built-in Node runtimes. Cursor needs the SDK you install and hand
over: `createRuntimeRegistry([...defaultRuntimes.list(), createCursorRuntime({ sdk: () => import("@cursor/sdk") })])`
([why](docs/runtimes/cursor.md#installation-and-account-usage)). Pi Durable needs
`createPiDurableRuntime({ harness, models })` with the host's already-open Harness
and its Models.

## Handy utilities, no session needed

OAR also offers a set of handy utilities you can use without running an
agent at all: is it installed, is it signed in (and sign it in or out),
which account and how much quota is left, which models it can run, is
there an update (and install it), what skills and tools it has. One API
covers every supported runtime, so a dashboard, a setup wizard or a quota
monitor needs no per-runtime code.

```ts
import { defaultRuntimes } from "@botiverse/oar";

for (const runtime of defaultRuntimes.list()) {
  const installation = await runtime.installation?.();
  if (installation?.kind === "available") {
    const [usage, models, update] = await Promise.all([
      runtime.accountUsage?.(installation),
      runtime.listModels?.(installation),
      runtime.checkUpdate?.(installation),
    ]);
    console.log(runtime.id, usage?.kind, models?.kind, update?.kind);
  }
}
```

- **Installation:** `installation()` finds the runtime on this machine and
  reports its version, with no account or network calls. When PATH found
  it, `shadowed` lists the other copies on PATH after it, which never run.
- **Login:** `login()` signs a runtime in through its own login without a
  terminal: it relays the sign-in URL or device code, and a code the person
  pastes back goes to the runtime only. `authStatus()` says whether it is
  signed in, and `logout()` signs it out through its own logout (claude,
  codex, cursor; [reference](docs/spec/login.md)). oar never handles the
  tokens.
- **Account usage:** `accountUsage()` reads the plan and quota windows with
  their reset times (claude, codex, grok, kimi;
  [reference](docs/spec/account-usage.md)).
- **Models:** `listModels()` lists the models the installation can run now,
  with their effort levels and service tiers; not being logged in is its own answer, not an
  empty list.
- **Updates:** `checkUpdate()` reports the version the runtime's own updater
  would install, and `upgrade()` runs that updater and judges it by the
  version afterwards ([reference](docs/spec/update.md)).
- **Inventories:** `skills()`, `mcpServers()` and `tools()` read what the
  runtime has configured natively ([reference](docs/spec/inventory.md)).
- **Session options:** `refusedSessionOptions` says which session options a
  runtime refuses, before anything opens; `session()` rejects them with an
  `UnsupportedOptionError` rather than drop them
  ([reference](docs/spec/runtime-matrix.md#refused-session-options)).
  `mcpServers` attaches MCP servers to one session (except Cursor and
  Pi Durable).

The CLI exposes the same queries: `oar installation`, `oar login`
(`--status` only reports), `oar logout`, `oar usage`, `oar models`,
`oar upgrade --check`, and `oar skills`, `oar mcps` and `oar tools`.

## CLI

```bash
npx @botiverse/oar-cli list
oar run claude "What does this repo do?" --record run.jsonl
```

Every command: [packages/cli](packages/cli/README.md) (published as `@botiverse/oar-cli`).

## Docs

- [Design](docs/design/README.md): why oar exists, its decisions and what comes next.
- [Spec](docs/spec/README.md): the record stream and every contract built on it.
- [Runtimes](docs/runtimes/README.md): what each runtime says natively and how oar maps it.
- [Prior art](docs/prior-arts/README.md): related projects compared feature by feature.
- [Development](docs/development.md): working in this repo.

ESM-only, Node entry requires Node.js 24+; the browser entry needs a modern browser
with Web Crypto. Apache-2.0.
