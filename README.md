# OAR - *programming interface for all agent harnesses*

<img src="assets/logo.png" alt="OAR logo" width="240">

OAR (**O**pen **A**gent **R**untime) is a programming interface: a
provider-independent contract that gives applications one way
to control and observe coding-agent runtimes — Claude Code, Codex, Grok,
Kimi, and Pi today. It is a foundation to build on — the session model,
event stream, identity, and attribution an application can safely bake into
its own data model — while the application itself owns the UX and AX.

Every runtime is driven through the same operations — detect the
installation, list the models, open a session, prompt it, steer or queue
input, watch the stream, resume later — and everything the runtime says
lands in one lossless, resumable record stream — everything the runtime
says, and nothing else. What a runtime cannot do is reported as a typed
`unsupported` instead of being faked.

## At a glance

- Project: OAR (Open Agent Runtime)
- Position: a foundation and programming interface for the application layer — see [docs/design/](docs/design/foundations.md)
- Core packages: [`@botiverse/oar`](packages/oar) (the library) and [`@botiverse/oar-cli`](packages/cli/README.md) (the `oar` executable)
- Main abstractions: `Runtime` (installation, models, account usage, session) and `Session` (prompt / steer / queue / abort / resume / records)
- The contract: one ordered, resumable record stream with self-attribution — [docs/spec/](docs/spec/README.md)
- The proof: one behavior suite runs the same cases against every backend — [sea-trial/](sea-trial/README.md)

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
| [`docs/runtimes/`](docs/runtimes/README.md) | Each runtime's programming interface and native concepts: API inputs/results, resume semantics, capabilities, current OAR mapping, and evidence gaps; includes Maka as a design reference |
| [`docs/spec/`](docs/spec/README.md) | The concrete record-stream contract the library emits (record shapes, attribution, session graph, cursor), kept deliberately separate from the design principles |
| [`docs/blog/`](docs/blog/README.md) | Long-form posts (the release post draft): the motivation and shipped surface in one read, with unsettled parts marked |
| [`docs/development.md`](docs/development.md) | Working in this repo: how to validate changes, how to add a runtime or fix a runtime bug, conventions, the commit gate — and pointers to the source-layout and test-suite docs that live next to the code |

The CLI lives in [`packages/cli/`](packages/cli/README.md) so library consumers do not install Commander. The Electron cockpit that dogfoods the library lives in its own repository, [botiverse/oar-coxswain](https://github.com/botiverse/oar-coxswain), and consumes the published npm package.

## Library

```ts
import { promptAndWait, runtimes } from "@botiverse/oar";

const grok = runtimes.require("grok");
const installation = await grok.installation?.();

if (installation?.kind === "available") {
  const session = await grok.session(installation, { cwd: process.cwd() });
  // One ordered record stream: the runtime's frames (events, verbatim plus
  // oar's typed views), your control actions (requests) and their answers
  // (responses), all on one monotonic seq.
  session.subscribe((record) => {
    if (record.kind === "event") {
      for (const view of record.body.views) {
        if (view.kind === "text_delta") process.stdout.write(view.text);
      }
    }
  });
  const run = await promptAndWait(session, "Inspect this repository");
  console.log(run.kind === "ended" ? run.outcome : run.reason);
  console.log(session.usage(), session.model());
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
oar models claude
oar run claude "What does this repo do?"
oar run claude "Summarize the tests" --record run.jsonl
```

The package is ESM-only, requires Node.js 24 or newer, and is licensed under Apache-2.0.
