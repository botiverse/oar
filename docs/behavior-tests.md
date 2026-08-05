# Behavior tests (`sea-trial`) — design

Draft. Every runtime passes the same suite. This document defines what gets tested hard, what
gets a smoke test, and the machinery that keeps the suite honest.

## Weight tests by how *quietly* a failure happens, not by how complex the code is

Complexity is the wrong selector. The failures that cost real money are the **silent** ones: a
session that resumes into a live-but-inert state, a turn that produces no tool calls and looks
like work, a suite that silently runs fewer cases than it used to, a config gap that only crashes
on one code path. A prompt that returns nothing is noticed in seconds and needs one smoke test.

> **Loud failure → one smoke case. Silent failure → adversarial cases, a positive control, and a
> detector.**

## Priority

### A — test adversarially

Recurring, and quiet when they break.

1. **Session resumption / reconnect.** The known signature is hang → watchdog restart → a session
   that is alive but emits zero tool calls. It recurs often enough that a dedicated detector was
   built for it, which is itself evidence of frequency. Assert: after resume the runtime still
   accepts prompts, still emits tool events, and **an alive-but-zero-tool turn is a failure, not a
   pass**.
2. **Launch-time configuration.** A missing or partial config must fail with a **readable, typed
   reason** — never a crash, and never a silent start that comes up inert.
3. **Busy state and interruption.** Semantics of sending while busy (what `acceptedAs` returns);
   a hung tool call must be observable and interruptible rather than blocking the loop.
4. **Process death mid-turn, and restart.** After a death inside a tool call the state machine
   must converge to a defined state, with no half-open turn left behind.

### B — normal coverage

Event ordering, usage normalisation, model selection and resolution.

### C — smoke only

Happy-path single turn, basic text streaming. One case each. These break loudly; a suite here is
wasted effort.

## Assert the envelope, never the payload

Model output is stochastic, so assertions are on protocol-observable facts: that a `tool_call`
named `echo` occurred, that it preceded its result, that `turn_end` closed the turn, that usage
normalised to the declared shape. Never on what the model said.

**Retries must be explicit.** An assertion that needs three attempts to pass is a flaky assertion
and must be labelled as one. Silent retry hides exactly the instability worth knowing about.

## Capability vector

`steer` · `interrupt` · `resume` · `tool_events` · `usage` · `permission-hooks` · `model_select`

Each case declares the capabilities it requires; each runtime declares what it has. A skip is
legal **only** when it maps to a declared missing capability.

> **An undeclared skip is a failure.**

This is the only mechanism that keeps this one conformance suite rather than N suites each
passing its own subset — which would be the "N special cases sharing a directory" outcome.

## Three outcomes, not two

| Outcome | Meaning |
| --- | --- |
| **PASS** | — |
| **FAIL** | The contract was violated. |
| **DRIFT** | Behaviour changed and may still be conformant; the recording no longer matches. |

Vendor CLIs change constantly. If every vendor update turns the board red, the suite gets muted —
and a muted suite is worse than none, because it still looks like coverage. DRIFT goes to human
triage, which ends in one of: amend the contract, re-record, or promote to FAIL.

## Determinism

Deterministic **time** exists today: a `Clock` interface and a fake clock with virtual time and a
stable tie-break, with timing routed through it across the daemon.

Deterministic **simulation** does not: no seeded scheduling or interleaving exploration, no
simulated I/O, no fault injection, and runtimes are real child processes.

That gap matters because **every case in priority A is a race**, and races are what deterministic
simulation can enumerate systematically while a hundred live runs may never hit them. Recorded
transcripts are a deterministic stand-in for the child process, so seeded scheduling layered over
replay is what would make A genuinely testable.

This is a concrete reason to get the driver boundary (chapter 1) right early: it decides whether
that is ever possible.
