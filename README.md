# Drydock

Run a Raft runtime **without the daemon**, and prove every runtime behaves the same way.

> Status: **private, pre-alpha, nothing works yet.** This document defines scope and the
> bar for going public. It is deliberately written to an external-consumer standard from
> the first commit — that standard is the point, not a formality.

## Why this exists

Raft's daemon drives ~12 agent runtimes (claude, codex, kimi, kimi-sdk, grok, gemini,
cursor, copilot, opencode, antigravity, pi, cliTransport). The valuable asset is not the
adapters — it is the **contract** that converges each vendor's quirks into one behaviour.

That contract currently exists only as tribal knowledge spread across the drivers. Two
observations from production motivated extracting it:

1. A production startup crash (`#749`) had its root cause in the **shared contract layer**,
   not in any vendor adapter: a type asserted a field the wire does not actually guarantee.
2. A census of the daemon found **20+ driver launch sites using the tolerant hydration path
   and zero using the strict validator**. The readable error already existed; no launch path
   could reach it.

An abstraction whose enforcement point is not reachable is not an abstraction. A library
*is* its enforcement boundary, which is why building this as a library — something an
outside consumer could use without our daemon — is what forces the contract to become real.

## The three parts

| Part | What it is | Analogue |
| --- | --- | --- |
| **RRP** (Raft Runtime Protocol) | The daemon↔runtime boundary, frozen as an explicit written contract with a per-chapter assertion list. | OpenDAL's `Operator` / trait |
| **Drydock** | An independent entry point that starts and drives a runtime **with no daemon present**. Script-driven, with transcript capture and replay. | `raftdev` |
| **sea-trial** | The conformance suite. Every runtime must pass the same suite. | OpenDAL's `behavior tests` — the actual moat |

### The load-bearing constraint

**Drydock must run without the daemon.** This is not an architectural preference; it is the
only property that cannot be faked. "Our internal abstraction is clean" is a claim we can
always tell ourselves. "A consumer who does not have our daemon can drive this runtime" is
a claim that is either true or fails loudly.

## Going public

Public release is gated on one condition, stated so it has teeth rather than becoming an
indefinite "someday":

> **sea-trial passes for every runtime driver.**

This pays out either way:

- **Green** — the abstraction is real; publishing is mostly packaging.
- **Not green** — we have N special cases sharing a directory rather than one contract.
  That finding is the return on this work regardless of whether anything is ever published.

## Open decisions (not settled — do not assume)

- **Licence.** Not chosen. Requires a real answer before the repo goes public.
- **Vendor terms.** Whether wrapping and distributing adapters for commercial vendor CLIs
  carries obligations has **not been checked**. Blocking for public release, not for work here.
- **Maintenance ownership.** Vendor CLIs change often. Today that churn is absorbed silently
  inside the monorepo; published, each absorption becomes a breaking change plus issue load.
  This needs a named long-term owner before release, not after.

## Current state

- A W1 slice exists in the monorepo (`packages/daemon/src/testing/drydock.ts`): event probes,
  fake clock, child-process-lifecycle-aware waits.
- It has not spread, and the reason is diagnosed: it only offers *wait for an in-process
  event*, while most hand-rolled waits in the daemon suite are waiting on the **filesystem**
  (artifacts written by child processes).
- **W2 is therefore filesystem/transcript coverage.** Without it, drydock cannot reach the
  main scenario and nobody will adopt it.
