# Motivation

**oar exists so that applications embedding agent runtimes write one
integration instead of N — against a contract that is lossless on the
producer side, semantically clear on the consumer side, and honest about what
each runtime can and cannot do.**

## The problem

Every harness exposes its own private access mechanism — an SDK, an
app-server, an ACP variant, a subprocess stdio protocol, an in-process
library — each with its own session model, event stream, usage reporting,
config, install and login story. A product that embeds more than one runtime
ends up writing N integrations, and each one is lossy or ad-hoc in its own
way.

The deeper problem is that the genuinely hard parts — a lossless attributed
event stream, session identity and resume, sub-agent association, token
attribution, capability differences — are *protocol* problems, and today
every application privately reinvents them, badly. We have concrete evidence:
one vendor's own protocol adapter drops its sub-agent events; another exposes
overlapping usage views that cannot be summed. Vendors' own remote-control
stacks (app-server modes, serve/leader modes, remote-control protocols) are
each a private single-runtime version of exactly this protocol, which
confirms the problem is real and general.

See [hard-problems.md](hard-problems.md) for the full inventory.

## Two goals

1. **Users are worry-free.** A consumer never needs to know whether a harness
   is driven via SDK, CLI, subprocess, or app-server.
2. **The engineering is high quality.** Self-explanatory structure, per-seam
   tests plus whole-system behavior suites, conformance-proven behavior
   rather than assumptions (see the repo-root
   [`AGENTS.md`](../../AGENTS.md)).

## Target users

- **Host products embedding agent runtimes.** oar deliberately depends on no
  host's auth, naming, or identities — any embedding product qualifies.
- **Tooling that consumes the record stream** — trajectory viewers, test
  harnesses, evaluation pipelines. oar emits the complete attributed stream;
  derivation and storage stay the consumer's business.
- **Advanced individual users via the `oar` CLI** — detect, install, catalog,
  config, drive.

Explicit non-goals: multi-language bindings, and being a storage/replay
system (that layer exists as separate protocols; oar emits, they persist).

## Why oar instead of each harness directly?

- **One contract instead of N mechanisms.** Detect / install / version
  catalog / login / usage / config / session-drive written once per
  application, not once per application × runtime.
- **Lossless producer, semantically clear consumer.** Everything the harness
  emits is available (unknown events preserved, never dropped), through a
  typed surface where status is a fold over events.
- **Honesty about differences, not lowest common denominator.** The
  capability surface declares what each runtime actually supports; strong
  harnesses aren't dragged down, weak ones return typed `unsupported`, and
  oar never fabricates structure a runtime doesn't expose
  (see [foundations.md](foundations.md)).
- **The hard problems solved once, with evidence.** Session resume,
  sub-agent and token attribution, version-skew safety (works inside the
  support window, typed rejection outside, never silently wrong).
- **Nothing lost.** Because the producer is lossless, native payloads remain
  reachable — using oar doesn't wall you off from harness-specific power.

## The honest boundary

If an application uses exactly one harness and its native SDK fits, direct
use is fine. oar pays off at two or more runtimes — or at one, when you want
durability against harness churn and someone else to have already absorbed
each vendor's quirks.
