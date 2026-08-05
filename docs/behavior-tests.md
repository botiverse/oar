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

**This already exists** in the extraction source, as a per-runtime descriptor every driver
declares. Its fields are exactly the axes along which runtimes differ:

```
transport / lifecycle / stdout.channel
input.initial : start | request | unsupported
input.idle    : stdin | request | sdk_prompt | unsupported
input.busy    : stdin_steer | request | sdk_steer | unsupported
readiness     : spawned | stdout_signal | healthcheck | sdk_ready
turnBoundary  : parsed_event | sdk_event | process_exit
startPolicy   : immediate | defer_until_concrete_message
inFlightWake  : queue | steer | spawn_new | coalesce_into_pending
busyDelivery  : direct | gated | notification | none
postTurn      : keep_alive | close_stdin | terminate_process
```

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

**Baseline, measured — the runtime layer has none of it.** A fake clock appears in five test
files, covering the host's own state machines: process manager (two), connection, reminder cache,
and the runner's own tests. In the driver layer — the adapters this project exists to extract —
it appears in **zero** of 34 test files, which wait on real time instead (one driver's tests alone
contain 27 real waits).

That is precisely why priority A keeps biting: those four cases are races, and a race under real
time only fires occasionally. A hundred green runs do not mean it is absent, only that it was not
hit — so today's green on those four carries almost no information.

Extracting this layer is therefore also the opportunity to move it from real time onto a
controllable clock. The runner already uses the fake clock; once its waiting surface covers the
filesystem and transcripts rather than only in-process events, the driver layer becomes testable
deterministically for the first time.

Recorded transcripts are a deterministic stand-in for the child process, so seeded scheduling
layered over replay is what would let priority A be enumerated systematically rather than waited
for.

### Where determinism applies, in priority order

1. **Enumerate the descriptor space.** Every axis above is a finite enum across roughly eleven
   axes, so the behaviour space is enumerable: synthesise a fake runtime for a descriptor
   combination and run the state machine against it. No real process, fully deterministic, and it
   reaches combinations **no current vendor exhibits** — which is exactly where the next vendor
   change lands.
2. **Busy / steer / turn races.** `turn_end` arriving against an in-flight steer; `stop` racing a
   tool result. Pure state machine — priority A case 3.
3. **Death mid-turn**, with death as an injectable event rather than a real kill: assert
   convergence and no half-open turn — priority A case 4.
4. **Config composition and validation.** Pure functions; needs no process at all, fake or real.
5. **Event normalisation** — a pure function over recorded transcripts.
6. **Timeout and backoff policy** — virtual time, which already exists.

The seam this needs is already present: a session is an interface carrying a descriptor plus
start/send/stop and an event stream, so a simulated implementation is straightforward. Preserving
that seam is what keeps determinism available; losing it in the extraction is what would forfeit
it.

### The limit worth stating

Simulation proves the state machine survives **the interleavings we simulate**. The grammar of
what can happen must therefore be derived from recorded real behaviour, or the exploration is
thorough inside a universe that does not exist. Coverage demonstrates sensitivity, not relevance.
