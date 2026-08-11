# RRP chapters, and which belong to `oar`

Draft. Chapters are frozen **one at a time**: each freeze produces short clause text plus that
chapter's assertion list, and every frozen clause becomes a `sea-trial` assertion. The protocol
grows out of the runner, rather than being written in full and then implemented.

## The test for what belongs here

> **Would a consumer without our daemon need this cell?**

Yes → `oar`. Only meaningful because a particular product's server exists → stays in that product.
This is the scope version of the same constraint that governs the code, and it is decidable per
item rather than a matter of taste.

## Chapters

| # | Chapter | Belongs to | Status |
| --- | --- | --- | --- |
| 1 | **Runtime interface** | oar | harvestable from existing code |
| 2 | **Calling interface** | oar (see split) | partly exists, see below |
| 3a | **Outbound events — observation** (incl. *status = fold(events)*) | oar | engineering ahead of docs; harvest |
| 3b | **Interception & permission (hooks)** | oar | **highest value, widest vendor divergence** |
| 4 | **Session & transcript** | oar | independent, can start anytime |
| 5 | **Capability negotiation** | oar | after ch.7 |
| 6 | **Trust boundary** | oar, minus credential-provisioning policy | placeholder until custom runtimes open externally |
| 7 | **Discovery & provisioning** | oar | partly exists; harvest |

### 2 — Calling interface

The original chapter was a *turn / delivery state machine*. Only part of that is general.

What `oar` takes is not the state machine but **the calling interface**: which operations exist
(start, prompt, steer, interrupt, stop), which are legal in which state, what happens when you
call at the wrong moment (queue, reject, or convert to a steer), and what the caller gets back.

This already exists in embryo — a driver today exposes `start({text})` and
`send({mode, text})` returning `{ok, acceptedAs: "prompt" | "steer"}`. That `acceptedAs` **is**
the answer to "what happens if I call while it is busy", and is directly harvestable as clause
text.

Delivery debt, wake and re-arm stay with the product: those are semantics about whether a message
should wake somebody, which is unrelated to how you drive a runtime.

### 3a / 3b — the split, and why it matters

The dividing line is **whether the consumer can say no.**

- **3a, observation** — turn lifecycle, tool execution facts, usage normalisation. The host reads,
  records and displays; it cannot change what happens. Telemetry.
- **3b, interception** — approve or deny a tool call, answer a permission prompt, release a
  credential. The host's answer **changes what happens next**.

Their contracts have nothing in common. Interception must specify a latency budget, **what a
timeout defaults to (approve or deny)**, failure semantics, and ordering guarantees between
interception points. Observation needs none of that. Merging them hides the question *can this
consumer refuse?*, which is precisely the security-relevant one.

3b is likely the most valuable chapter in the set: sandboxing, approval and permission are where a
host exercises control, and vendor behaviour diverges most (synchronous interception, after-the-fact
notification only, or nothing at all). Widest divergence is where a uniform interface is worth most.

### 3a — the envelope and its payload (and why it is not a network stack)

Every event has two faces, one for each side that pulls against the other — a
clean typed contract for the consumer, no lost detail for the producer:

- **envelope** — the typed, common meaning the *consumer* reads and folds to
  status. Stable across every runtime.
- **payload** — the runtime's raw detail, carried verbatim for the *producer*,
  so nothing is dropped. The normalizer decides only *which* envelope a raw
  event means; it never discards raw. No raw with nowhere to go ⇒ no untyped
  catch-all variant is needed.

That is a header/body split, and **only that much is network-like.** It is
deliberately *not* a network stack:

- **Single layer, not nested.** One header+body per event — there is no envelope
  wrapping an envelope wrapping an envelope.
- **N-to-M, not a bijection.** The raw→envelope map is a semantic *translation*,
  not a one-to-one encapsulation: the normalizer may drop a raw event (a
  heartbeat → nothing), split one raw into several events, or coalesce several
  raw into one. Whether a semantically-important raw (a tool call) is lifted into
  its envelope kind is a *judgement* — and getting it wrong is where status
  drifts silently. The cross-runtime conformance fixture guards exactly this.
- **Reduction, not accretion.** A network stack *grows* by layer (each adds a
  header); oar's `raw → event → status` *shrinks* by layer (status ⊂ events ⊂
  raw). Status is a lossy projection, not a wrapper.

### 3a — status is a projection of the event stream, never a stored field

The events are the primary facts; **status is `fold` over them.** A runtime does not *set* a
status the host then trusts — it *emits events*, and the host computes status from the event
prefix seen so far. There is no `set_status` in the protocol, only `emit_event`.

The event stream is append-only, past-tense, ordered, and immutable:

```
turn_started · tool_call · tool_result · turn_end{completed | interrupted | crashed} · runtime_error
```

Status (`idle` / `thinking` / `tool-executing` / `stopped` / `crashed`) is a pure function of that
prefix. **Why derived and not a field of its own:** an independently-settable status can disagree
with the events — the status says `idle` while an un-closed `tool_call` says otherwise — and that
disagreement is invisible, because nothing forces the field false. A derived status *cannot* drift:
it is recomputed from the facts every time. So **the derivation function itself is the contract**,
shipped alongside the event union, not a status enum each vendor fills in its own way. Every
consumer that folds the same events gets the same status.

**Two levels, and they must not be merged:**

| level | states | folds from |
| --- | --- | --- |
| **process lifecycle** | launching / running / stopped / crashed | daemon residency + process-level events |
| **turn lifecycle** | idle / thinking / tool-executing / turn-end | in-process turn events |

A process that is `running` while its turn is `idle` is a legal, common state; collapsing the two
loses exactly that distinction. And `crashed ≠ completed`: only a derived projection can express
"the process ended without ever producing a `turn_end{completed}`" — the silent-failure case an
independently-set `done` flag cannot tell apart from a clean finish.

This is not academic. The concrete failure it prevents: **marking an agent terminal is a status bug
whenever `terminal` is set independently rather than folded from events.** A recoverable
remote-compaction or provider-capacity failure is *not* agent-terminal, but a hand-set flag makes it
so and the process is killed. The first-principles fix is the rule above — `terminal` / `crashed`
must fold from the event stream, and a retriable failure event must not fold to `terminal`. (Raft's
`packages/daemon/src/runtimeTurnState.ts` already states the shape: the normalizer decides which raw
event means turn-started / tool-boundary, and `RuntimeTurnState` "owns only the derived state
budget" — status is downstream of events, never a peer of them.)

### 6 — Trust boundary: authentication is a capability axis

How a runtime authenticates differs in kind, not degree, so it is a declared capability rather
than a config field:

| mode | who holds the secret |
| --- | --- |
| **ambient** | the runtime's own login state on the host; **this layer holds nothing** |
| **explicit-key** | the caller supplies one |
| **delegated** | the host holds a session obtained on the user's behalf |
| **gateway** | the host routes through its own endpoint; the runtime never sees a provider credential |

Three properties, in order of how much they matter:

**Holding no secret is first-class, not a degenerate case.** `ambient` lets a consumer drive a
runtime without ever touching a credential, which keeps them out of the secret-custody business.
Layers that build explicit-key first and retrofit ambient leave it a second-class path forever.

**The resolved mode must be readable back.** The classic failure in credential chains is silent
fallback: you believe you are using key A and you are using whatever the environment held. For
agents that is worse than wrong — it bills someone else. The contract must answer *which mode did
this session actually use*, as a closed-set mode name, never the secret. Configured-as is not
authenticated-as.

**Precedence is declared, and ambient fallback is opt-in.** Default is: use what was supplied,
fail if it is absent. Otherwise something works locally on a developer's own login and fails in
CI — or an agent process quietly spends a human's account.

**Two properties learned in production, stated as contract rather than implementation choice:**
credentials must never enter ordinary runtime config or a restart snapshot — a *reference*
travels and is materialised at launch; and **a credential reference and a resolved credential are
two types**, converted only by a function that can fail, never by an assertion. The crash that
motivated this project was an assertion collapsing exactly that distinction.

**Acceptance check:** the capability record must be sufficient to drive a create-agent form —
which fields to show, which are required, which are mutually exclusive. If the form cannot be
generated from it, the model is underspecified.

### 7 — Discovery & provisioning

Presence detection, version read and minimum-version rules, model enumeration and resolution, and
what happens when a runtime is absent (fail, or install).

This is **before** capability negotiation, not part of it: negotiation presupposes the CLI is
present and runnable, while this answers whether it is there at all and whether its version can
support what you are about to negotiate. Merged, the first real failure — installed but too old —
has no owner.

## Chapter 1's design premise: capability, guarantee, mechanism

The extraction source already carries a per-runtime descriptor, and it is tempting to adopt it as
the capability model. It should be **demoted to corpus rather than adopted as specification** —
it records what we happened to encounter, not what must exist. Four problems make it unsuitable
as-is.

**It fuses capability with mechanism.** An axis reading `stdin | request | sdk_prompt |
unsupported` is three implementations of one capability plus one genuine capability statement.
Whether input arrives over stdin or an SDK call is exactly what this layer exists to hide;
encoding it in the contract leaks the adapter through the interface.

**It describes our adapters, not observable behaviour.** Transport and stream-channel fields say
how we talk to a runtime, which a consumer cannot observe.

> **Razor: if two values are indistinguishable to a consumer, they are not two contract values.**

**It hands divergence upward instead of absorbing it.** An axis with four distinct in-flight-wake
behaviours obliges the consumer to write four code paths — the abstraction failing precisely
where it should pay off. Each axis must answer: *is this irreducibly different observable
semantics, or did we simply not unify it?* A catalogue of how N adapters differ produces N
special cases sharing a directory, which is the outcome this project exists to avoid.

**It is silent on every path that has actually hurt.** Resumption going inert, hung tool calls,
death mid-turn, a start that succeeds but comes up ineffective — none of these have an axis. The
descriptor covers plumbing that has never caused an incident. Absorbing failure experience means
the contract needs failure-side axes: what holds after resume, what liveness is guaranteed for a
tool call, and what state must be converged to after abnormal exit.

**And capability is resolved, not declared.** Support can depend on version and configuration,
which is why discovery (ch.7) precedes negotiation (ch.5). A constant per driver cannot express
"steer, from version X onward".

### What replaces it — deliberately small

A flat capability record: booleans and limits, one per thing a consumer may rely on. Nothing
else. Storage-abstraction layers run ~50 backends on exactly this and it holds; a richer ontology
is not earned yet.

**Guarantees are not a second taxonomy — they are the assertions.** Ordering, liveness, and the
state converged to after failure belong in `sea-trial` as executable cases, not in a category
system. A guarantee that isn't a test is prose.

**Mechanism stays out of the contract entirely.** The usual way to hold that line is two layers:
an ergonomic public API for consumers, and a raw trait that backends implement. Consumers never
see the raw one, so mechanism has nowhere to leak to.

**Cross-cutting concerns compose rather than repeat.** Retry, timeout, logging and tracing belong
in stackable middleware over the backend trait, not re-implemented per adapter — otherwise every
new runtime re-pays for them and each pays slightly differently, which is how divergence gets
manufactured internally.

**Push errors to the compiler.** The aim is that the natural way to write a call is the correct
one, and that mistakes surface as type errors rather than incidents:

- **No casts on the contract boundary.** A cast is an unchecked assertion that silences exactly
  the checker that would have found the bug. The production crash that motivated this project was
  one cast erasing an optional field; without it, every read site would have failed to compile.
  Contract values are built by validating constructors returning a result, never asserted into
  existence.
- **State lives in the type, not in a runtime check.** A handle that is mid-turn should not offer
  the operations that are illegal mid-turn. Then "prompted while busy" stops being a case to test
  and becomes a program that does not compile.
- **Events are a discriminated union with exhaustive handling**, so a new event kind breaks every
  consumer that ignores it — at build time. Silently dropping an unrecognised kind is a failure
  mode we have already paid for.
- **Capability flags narrow types**, rather than only documenting what to skip. Where capability
  is known statically, gate the API; where it is resolved at runtime by version, a check on the
  flag narrows the handle.

The line not to cross: ordinary discriminated unions, exhaustive switches and state-typed handles
are the tool. Type-level computation that produces unreadable errors or that only its author can
extend costs more than the bugs it prevents. State-typed handles in particular make generic
wrappers harder to write — worth it at the boundary, not everywhere.

**Admissibility:** an axis exists only where a consumer must branch on it. If it is unobservable,
or observable but cannot change what the consumer does, absorbing it is this layer's job.

Working method for chapter 1: walk the existing descriptor axis by axis, keep only what survives
the razor, and express each survivor as a capability flag or an assertion. Whatever fails is this
layer's debt, not something to pass upward.

## Suggested order

1. **7** and **3a** — both have running code to harvest; cheapest first clauses.
2. **2** — `acceptedAs` and the operation set are already real.
3. **3b** — highest value, and the one worth the most design attention.
4. **4**, then **1** consolidated from what the above establish.
5. **5** after 7. **6** stays a placeholder until custom runtimes open externally.
