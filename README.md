# OAR - *programming interface for all agent harnesses*

<div align="center">
  <img src="assets/logo.png" alt="OAR logo" width="120">
</div>

OAR (**O**pen **A**gent **R**untime) is a provider-independent programming interface for coding-agent runtimes: a solid foundation for building agent workspaces and other applications.

**Delete harness logic and focus on outcomes and UX.**

## Supported runtimes

Claude Code, Codex, Grok Build, Kimi Code, Pi

## Docs


| Read                                         | To answer                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| [docs/design/](docs/design/README.md)        | Why oar exists and which design problems it treats as load-bearing       |
| [docs/spec/](docs/spec/README.md)            | The concrete record-stream contract (record shapes, attribution, cursor) |
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
  const run = await promptAndWait(session, "Inspect this repository");
  console.log(run.kind === "ended" ? run.outcome : run.reason);
  await session.dispose();
}
```

`events()` is the flat, attributed reading of the session: one `Event` per
fact (text, reasoning, tool call start / progress / end, turn start and
end, usage, model, compaction, retry, app requests, control rejections, the
process exit), with `seq` and `agentPath` on each. Pass `{ coalesceText: true }` to
get text in blocks instead of pieces. When the runtime's own frame matters,
`session.rawEvents()` and `session.records()` expose the underlying record
stream with every native payload verbatim.



## CLI

```bash
npx @botiverse/oar-cli list
oar run claude "What does this repo do?" --record run.jsonl
```

ESM-only, requires Node.js 24+, Apache-2.0.
