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
| 3a | **Outbound events — observation** | oar | engineering ahead of docs; harvest |
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

### 7 — Discovery & provisioning

Presence detection, version read and minimum-version rules, model enumeration and resolution, and
what happens when a runtime is absent (fail, or install).

This is **before** capability negotiation, not part of it: negotiation presupposes the CLI is
present and runnable, while this answers whether it is there at all and whether its version can
support what you are about to negotiate. Merged, the first real failure — installed but too old —
has no owner.

## Suggested order

1. **7** and **3a** — both have running code to harvest; cheapest first clauses.
2. **2** — `acceptedAs` and the operation set are already real.
3. **3b** — highest value, and the one worth the most design attention.
4. **4**, then **1** consolidated from what the above establish.
5. **5** after 7. **6** stays a placeholder until custom runtimes open externally.
