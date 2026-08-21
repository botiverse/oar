# oar

`@botiverse/oar` defines provider-independent contracts for observing agent runtimes.

The clean first surface intentionally contains two independent optional capabilities:

- `installation.probe()` observes local installation/version facts without login or usage I/O.
- `accountUsage.read()` observes credentialed account usage without being coupled to installation detection.

Codex and Claude are the first built-in runtime implementations.

## Library

```ts
import { runtimes } from "@botiverse/oar";

const codex = runtimes.require("codex");
const installation = await codex.installation?.probe();
const usage = await codex.accountUsage?.read();
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

The package is ESM-only, requires Node.js 20 or newer, and is licensed under Apache-2.0.
