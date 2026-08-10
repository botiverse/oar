# oar

**An agent client access layer.**

Programmable access to agent runtimes — Codex, Claude Code, Kimi Code, Gemini CLI, Cursor,
Copilot, opencode, ACP-speaking agents, and more.

One interface, any runtime, plus a conformance suite that proves they actually behave the same.

An *agent client* is the host side: it starts a runtime, drives it, and consumes its events.
`oar` is the access layer for that side, the way a data access layer sits over storage backends.

> Status: **private, pre-alpha, nothing works yet.** This document defines scope and the bar for
> going public. It is written to an external-consumer standard from the first commit — that
> standard is the point, not a formality.

They all do roughly the same job and none of them agree on the details: process lifecycle, event
shapes, session resumption, model selection, credentials, even what a "turn" is. Writing the
adapters is tedious but tractable. The hard part is the contract, which is usually never written
down — so the bugs land in the layer that claims to normalise them, and the strict validator ends
up somewhere no live path reaches.

## The three parts

| Part | What it is |
| --- | --- |
| **RRP** | The host↔runtime boundary, frozen as an explicit written contract, one chapter at a time, each with its own assertion list. Chapter map: [docs/rrp-chapters.md](docs/rrp-chapters.md). |
| **drydock** | Starts and drives a runtime **with no host daemon present**. Script-driven, with transcript capture and replay. The testing/operations surface. |
| **sea-trial** | The conformance suite. Every runtime must pass the same suite. Design: [docs/behavior-tests.md](docs/behavior-tests.md). |

"drydock" names that harness specifically, not the project: a dry dock is where a vessel is
lifted clear of the water to be inspected and worked on. That is the right word for the runner
and the wrong word for an interface layer, which is why the umbrella needs its own name.

The durable asset is the behaviour suite, not the backend count: backends are volume, the suite
is what makes the interface mean anything.

### The load-bearing constraint

**drydock must work without a host daemon.** This is not an architectural preference; it is the
only property here that cannot be self-certified. "Our abstraction is clean" is a claim any
project can tell itself indefinitely. "A consumer who does not have our daemon can drive this
runtime" is either true or it fails loudly. Every design question should be settled by asking
which answer keeps that claim honest.

## Who it is for

Any project that drives more than one agent runtime and is tired of re-deriving the contract.

The first consumer is [Raft](https://github.com/botiverse), which runs ~12 agent runtimes in
production and supplies the breadth of real-world behaviour this contract has to survive. That
experience is a seed corpus, not the specification. Where one product's needs and a general
contract diverge, the general contract wins — **including when that means breaking how the first
consumer uses it today.** A layer that must preserve one product's existing shapes is that
product's internals wearing a coat, so the freedom to break them is what makes a general design
possible at all.

*(When this actually drives those runtimes, this should read "powers Raft". It does not yet, so
it does not say so.)*

## Going public

Public release is gated on one condition, stated so it has teeth rather than decaying into an
indefinite "someday":

> **sea-trial passes for every runtime driver.**

This pays out either way:

- **Green** — the abstraction is real; publishing is mostly packaging.
- **Not green** — what exists is N special cases sharing a directory rather than one contract.
  That finding is the return on this work regardless of whether anything is ever published.

## Licence

[Apache-2.0](LICENSE).

## Open decisions (not settled — do not assume)

- **Vendor terms.** Whether distributing adapters that wrap commercial vendor CLIs carries
  obligations has **not been checked**. Blocks public release, not work here.
- **Maintenance ownership.** Vendor CLIs change often. Absorbed privately, that churn is
  invisible; published, each absorption is a breaking change plus issue load. Needs a named
  long-term owner before release, not after.
- **Whether `RRP` survives as a separate name.** Leaning keep: the chapter map shows the full
  boundary is genuinely larger than `oar` (ch.2's delivery half stays with the product), so the
  two names denote different things.

## CLI (`oar detect`)

Always use **pnpm** locally:

```bash
pnpm oar detect                 # all registry runtimes (four-state summary)
pnpm oar detect pi              # one runtime: full models list (providers when present)
pnpm oar detect codex --profile # phase timings (ms) on the human table
pnpm oar detect kimi --json     # single-runtime JSON includes models; full-board --json stays v1-narrow
pnpm oar detect --profile --json
```

- `<runtime>` must be a registry id (`claude`, `codex`, `grok`, `antigravity`, `copilot`,
  `cursor`, `gemini`, `kimi`, `opencode`, `pi`). Unknown id → error + legal id list (no silent empty).
- Four failure states stay explicit: `not_installed` / `needs_login` / `models_unavailable` /
  `detect_failed`. `user-configured` escape models are listed, not collapsed.
- Product ids `pi` and `kimi` probe **SDK paths only** (no CLI mode this round).

## Current state

- A W1 prototype exists: event probes, a fake clock, and
  child-process-lifecycle-aware waits (a wait fails immediately when the child dies rather than
  hanging to timeout).
- It has not spread, and the reason is known: it only offers *wait for an in-process event*,
  while most hand-rolled waits in a real suite are waiting on the **filesystem** — artifacts
  written by child processes.
- **W2 is therefore filesystem/transcript coverage.** Without it, drydock cannot reach the main
  scenario and nobody will adopt it.
