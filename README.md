# oar

`@botiverse/oar` defines provider-independent contracts for controlling and observing agent runtimes.

The clean first surface intentionally contains two independent optional capabilities:

- `runtime.installation()` observes local installation/version facts without login or usage I/O.
- `runtime.accountUsage(installation)` observes credentialed account usage without coupling it to installation detection.

Claude, Codex, Grok, Kimi, and Pi are built-in runtime implementations. Grok and Kimi share a private ACP v1 transport and session kernel while remaining distinct public runtimes; there is intentionally no generic `acp` runtime identity.

## Repo knowledge index

This README is the canonical entry point to repo knowledge. It stays a
concise index; each area keeps its detail in its own file, and adding or
removing one of those files updates this table in the same commit.

| Read | To answer |
|---|---|
| [`docs/design/`](docs/design/README.md) | Why oar exists, who it is for, and which design problems it treats as load-bearing |
| [`docs/spec/`](docs/spec/README.md) | The concrete v2 record-stream contract (record shapes, attribution, session graph, cursor) — a draft under review, kept deliberately separate from the design principles |
| [`docs/development.md`](docs/development.md) | Working in this repo: the test estate, testing conventions, and the commit gate |
| [`packages/oar/src/README.md`](packages/oar/src/README.md) | Source layout and ownership: contracts / runtimes / shared / observe |
| [`sea-trial/README.md`](sea-trial/README.md) | The behavior/conformance suite: cases, harness, fixtures, vendor tests |
| [`experiments/README.md`](experiments/README.md) | Live probes with conclusions; the empirical evidence base |
| [`apps/coxswain/README.md`](apps/coxswain/README.md) | The Electron cockpit for dogfooding oar |

The CLI lives in [`packages/cli/`](packages/cli/README.md) so library consumers do not install Commander.

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

## CLI

The CLI is published separately as `@botiverse/oar-cli`.

```bash
npx @botiverse/oar-cli list
oar list
oar installation
oar installation codex
oar usage claude
```

The package is ESM-only, requires Node.js 24 or newer, and is licensed under Apache-2.0.
