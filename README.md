# Drydock

Drive an agent CLI runtime **without a host daemon**, and prove every runtime behaves the same way.

> Status: **private, pre-alpha, nothing works yet.** This document defines scope and the bar
> for going public. It is written to an external-consumer standard from the first commit —
> that standard is the point, not a formality.

## The problem

Agent CLI runtimes — Claude Code, Codex, Gemini CLI, Cursor, Copilot, opencode, Kimi, Grok,
and others — all do roughly the same job and none of them agree on the details. They differ on
process lifecycle, streaming event shapes, session resumption, model selection, credential
handling, and what a "turn" even is.

Anyone building on more than one of them writes an adapter layer. The adapters are tedious but
tractable. **The hard part is the contract**: the set of behaviours you promise your callers
regardless of which runtime is underneath. That contract is usually never written down. It
lives as tribal knowledge spread across the adapters, and every project re-derives it badly.

Two failure modes follow, and both are common enough to be worth naming:

1. **The contract layer is where the bugs are.** Not the vendor adapters — the shared code that
   claims to normalise them. A type that asserts a field the wire does not actually guarantee
   will crash at launch, and it will crash identically for every runtime.
2. **The enforcement point is unreachable.** A strict validator exists, produces a good error,
   and no live code path calls it — because internal callers can always reach around it to a
   tolerant helper. An abstraction whose enforcement point can be bypassed is not an abstraction.

Drydock exists to make both of those impossible to hide.

## The three parts

| Part | What it is |
| --- | --- |
| **RRP** | The host↔runtime boundary, frozen as an explicit written contract, one chapter at a time, each chapter with its own assertion list. |
| **Drydock** | An entry point that starts and drives a runtime **with no host daemon present**. Script-driven, with transcript capture and replay. |
| **sea-trial** | The conformance suite. Every runtime must pass the same suite. |

If you know OpenDAL: **RRP** is the trait, the runtimes are the backends, and **sea-trial** is
`behavior tests` — which is the part that actually carries the value, not the backend count.

### The load-bearing constraint

**Drydock must run without a host daemon.** This is not an architectural preference; it is the
only property here that cannot be self-certified. "Our abstraction is clean" is a claim any
project can tell itself indefinitely. "A consumer who does not have our daemon can drive this
runtime" is either true or it fails loudly. Every design question should be settled by asking
which answer keeps that claim honest.

## Going public

Public release is gated on one condition, stated so it has teeth rather than decaying into an
indefinite "someday":

> **sea-trial passes for every runtime driver.**

This pays out either way:

- **Green** — the abstraction is real; publishing is mostly packaging.
- **Not green** — what exists is N special cases sharing a directory rather than one contract.
  That finding is the return on this work regardless of whether anything is ever published.

## Open decisions (not settled — do not assume)

- **Licence.** Not chosen. Needs a real answer before this goes public.
- **Vendor terms.** Whether distributing adapters that wrap commercial vendor CLIs carries
  obligations has **not been checked**. Blocks public release, not work here.
- **Maintenance ownership.** Vendor CLIs change often. Absorbed privately, that churn is
  invisible; published, each absorption is a breaking change plus issue load. Needs a named
  long-term owner before release, not after.
- **What RRP stands for.** Currently just an acronym. It should not expand to anything
  product-specific.

## Current state

- A W1 prototype exists: event probes, a fake clock, and
  child-process-lifecycle-aware waits (a wait fails immediately when the child dies rather than
  hanging to timeout).
- It has not spread, and the reason is known: it only offers *wait for an in-process event*,
  while most hand-rolled waits in a real suite are waiting on the **filesystem** — artifacts
  written by child processes.
- **W2 is therefore filesystem/transcript coverage.** Without it, Drydock cannot reach the main
  scenario and nobody will adopt it.
