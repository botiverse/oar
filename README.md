# OAR - *programming interface for all agent harnesses*

<div align="center">
  <img src="assets/logo.png" alt="OAR logo" width="120">
</div>

OAR (**O**pen **A**gent **R**untime) is a provider-independent programming interface for coding-agent runtimes: a solid foundation for building agent workspaces and other applications.

## Supported runtimes

Claude Code, Codex, Grok Build, Kimi Code, Pi

## Docs


| Read                                         | To answer                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| [docs/design/](docs/design/README.md)        | Why oar exists and which design problems it treats as load-bearing       |
| [docs/spec/](docs/spec/README.md)            | The concrete record-stream contract (record shapes, attribution, cursor) |
| [docs/development.md](docs/development.md)   | Working in this repo: validate changes, add a runtime, conventions       |
| [packages/cli/](packages/cli/README.md)      | The `oar` executable, published separately as `@botiverse/oar-cli`       |




## Library

```ts
import { promptAndWait, runtimes } from "@botiverse/oar";

const grok = runtimes.require("grok");
const installation = await grok.installation?.();

if (installation?.kind === "available") {
  const session = await grok.session(installation, { cwd: process.cwd() });
  session.subscribe((record) => {
    if (record.kind === "event") {
      for (const view of record.body.views) {
        if (view.kind === "text_delta") process.stdout.write(view.text);
      }
    }
  });
  const run = await promptAndWait(session, "Inspect this repository");
  console.log(run.kind === "ended" ? run.outcome : run.reason);
  await session.dispose();
}
```



## CLI

```bash
npx @botiverse/oar-cli list
oar run claude "What does this repo do?" --record run.jsonl
```

ESM-only, requires Node.js 24+, Apache-2.0.