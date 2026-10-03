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

## Docs

| Read                                         | To answer                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| [docs/design/](docs/design/README.md)        | Why oar exists and which design problems it treats as load-bearing       |
| [docs/spec/](docs/spec/README.md)            | Record-stream and query contracts |
| [Conversation projection](docs/spec/conversation.md) | Build a conversation UI from requests, responses and native messages |
| [docs/spec/inventory.md](docs/spec/inventory.md) | Independent native skills, MCP server and tool queries |
| [docs/spec/subagents.md](docs/spec/subagents.md) | Subagents on any runtime, from a host or over `oar mcp` |
| [docs/spec/update.md](docs/spec/update.md)   | Update checks and upgrades through each runtime's own updater |
| [docs/spec/login.md](docs/spec/login.md)     | Signing a runtime in through its own login, and its sign-in status |
| [docs/runtimes/](docs/runtimes/README.md)    | What each runtime says natively and how oar maps it |
| [docs/development.md](docs/development.md)   | Working in this repo: validate changes, add a runtime, conventions       |
| [packages/cli/](packages/cli/README.md)      | The `oar` executable, published separately as `@botiverse/oar-cli`       |
| [docs/design/system.md](docs/design/system.md) | How the library, evidence layer, projections, and continuation form one agent-facing system |
| [docs/prior-arts/feature-comparison.md](docs/prior-arts/feature-comparison.md) | Surveyed projects compared by concrete features and evidence |
| [docs/design/decisions.md](docs/design/decisions.md) | Design decisions, their evidence, and conditions for reconsideration |
| [docs/design/roadmap.md](docs/design/roadmap.md) | Which system improvements are next, and what evidence gates them |

## Library

```ts
import { promptAndWait, runtimes } from "@botiverse/oar";

const grok = runtimes.require("grok");
const installation = await grok.installation?.();

if (installation?.kind === "available") {
  const session = await grok.session(installation, { cwd: process.cwd() });
  session.events((event) => {
    switch (event.kind) {
      case "text_delta": process.stdout.write(event.text); break;
      case "tool_call_started": console.log(`[${event.tool}]`); break;
      case "turn_ended": console.log(event.outcome.kind); break;
    }
  });
  const run = await promptAndWait(session, "Inspect this repository", { timeoutMs: 120_000 });
  console.log(run.kind === "rejected" ? run.code : run.outcome);
  await session.dispose();
}
```

`events()` is the flat, attributed reading of the session: one `Event` per
fact (native user message echoes, text, reasoning, background tasks, tool call
start / progress / end, turn start and end, usage, model, effort, compaction,
retry, app requests, control rejections, the process exit), with `seq` and
`agentPath` on each. Pass `{ coalesceText: true }` to get text in blocks
instead of pieces. When the runtime's own frame matters, `session.rawEvents()`
and `session.records()` expose the underlying record stream with every native
payload verbatim. The [package README](packages/oar/README.md) lists the
public entry points.

## CLI

```bash
npx @botiverse/oar-cli list
oar run claude "What does this repo do?" --record run.jsonl
```

ESM-only, requires Node.js 24+, Apache-2.0.
