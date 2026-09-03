# oar

`@botiverse/oar` defines provider-independent contracts for controlling and observing agent runtimes.

Why the project exists, who it is for, and which design problems it treats as load-bearing: [`docs/design/`](docs/design/README.md).

The concrete v2 record-stream contract (record shapes, attribution, session graph, cursor) — currently a draft under review, kept deliberately separate from the design principles: [`docs/spec/`](docs/spec/README.md). Each directory's README states how to keep its pages in sync with the code.

The clean first surface intentionally contains two independent optional capabilities:

- `runtime.installation()` observes local installation/version facts without login or usage I/O.
- `runtime.accountUsage(installation)` observes credentialed account usage without coupling it to installation detection.

Claude, Codex, Grok, Kimi, and Pi are built-in runtime implementations. Grok and Kimi share a private ACP v1 transport and session kernel while remaining distinct public runtimes; there is intentionally no generic `acp` runtime identity.

## Library

```ts
import { runtimes } from "@botiverse/oar";

const grok = runtimes.require("grok");
const installation = await grok.installation?.();

if (installation?.kind === "available") {
  const session = await grok.session(installation, { cwd: process.cwd() });
  const result = session.prompt("Inspect this repository");
  if (result.kind === "turn") {
    console.log(await result.turn.outcome);
  }
  console.log(await grok.accountUsage?.(installation));
  await session.dispose();
}
```

The source ownership model is documented in [`packages/oar/src/AGENTS.md`](packages/oar/src/AGENTS.md):

- `packages/oar/src/contracts/` — stable provider-independent agreements.
- `packages/oar/src/runtimes/<id>/` — concrete implementations split by capability.
- `packages/oar/src/shared/` — policy-free reusable mechanisms.
- `packages/cli/` — the separately installable CLI and its Commander dependency.
- `drydock/` — daemon-free execution vehicle.
- `sea-trial/` — shared behavior/conformance judgments.

## CLI

The CLI is published separately as `@botiverse/oar-cli`, so library consumers do not install Commander.

```bash
npx @botiverse/oar-cli list
oar list
oar installation
oar installation codex
oar usage claude
```

The package is ESM-only, requires Node.js 24 or newer, and is licensed under Apache-2.0.
