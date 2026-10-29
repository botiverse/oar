# Motivation

**oar exists so that applications embedding agent runtimes write one
integration instead of N, against a contract that is lossless on the
producer side, semantically clear on the consumer side, and honest about what
each runtime can and cannot do.**

## The problem

Every harness exposes its own private access mechanism: an SDK, an
app-server, an ACP variant, a subprocess stdio protocol, an in-process
library. Each has its own session model, event stream, usage reporting,
config, install and login story. A product that embeds more than one runtime
ends up writing N integrations, and each one is lossy or ad-hoc in its own
way.

The deeper problem is that the genuinely hard parts (a lossless attributed
event stream, session identity and resume, sub-agent association, token
attribution, capability differences) are *protocol* problems, and today
every application privately reinvents them, badly. We have concrete evidence:
one vendor's own protocol adapter drops its sub-agent events; another exposes
overlapping usage views that cannot be summed. Vendors' own remote-control
stacks (app-server modes, serve/leader modes, remote-control protocols) are
each a private single-runtime version of exactly this protocol, which
confirms the problem is real and general.

See [hard-problems.md](hard-problems.md) for the full inventory.

## The bet

oar is a bet on where innovation concentrates: **the larger innovation
happens at the application layer, not the harness layer.** Coding agent
runtimes are converging (on session models, event streams, sub-agent
patterns, usage reporting), and the differences that remain are exactly the
kind a protocol can absorb. Applications, by contrast, are where the design
space is still wide open: UX for humans and AX (agent experience) for the
agents themselves.

The bet has a practical consequence: an application should be able to invest
in UX and AX design without caring how a concrete task is run; that is the
harness's concern, and oar's job is to keep it there. But this is not an
argument for hiding the runtime. oar must expose enough surface for the
application to *control* the runtime (drive sessions, steer and cancel,
read capabilities, reach native payloads) so that abstraction never costs
control (see the capability and losslessness positions in
[foundations.md](foundations.md)).

If the bet is wrong, if harnesses diverge rather than converge, the
lossless producer and the per-runtime capability surface are the hedge:
nothing a runtime exposes is walled off.

## Two goals

1. **Users are worry-free.** A consumer never needs to know whether a harness
   is driven via SDK, CLI, subprocess, or app-server.
2. **The engineering is high quality.** Self-explanatory structure, per-seam
   tests plus whole-system behavior suites, conformance-proven behavior
   rather than assumptions (see
   [`docs/development.md`](../development.md)).

## Target users

- **Host products embedding agent runtimes.** oar deliberately depends on no
  host's auth, naming, or identities; any embedding product qualifies.
- **Tooling that consumes the record stream**: trajectory viewers, test
  harnesses, evaluation pipelines. oar emits the complete attributed stream;
  derivation and storage stay the consumer's business.
- **Advanced individual users via the `oar` CLI**: detect runtimes, read
  models, usage and native inventories, run a prompt, check for and apply
  runtime updates, and serve subagents over MCP.

Explicit non-goals: multi-language bindings, and being a storage/replay
system (that layer exists as separate protocols; oar emits, they persist).

## Why oar instead of each harness directly?

- **One contract instead of N mechanisms.** Detection, version and update
  checks, model catalogs, account usage, native inventories and session
  control are written once per application, not once per application and
  runtime.
- **Lossless producer, semantically clear consumer.** Everything the harness
  emits is available (unknown events preserved, never dropped), through a
  typed surface where status is a fold over events.
- **Honesty about differences, not lowest common denominator.** The
  capability surface shows what each runtime actually supports
  ([capabilities](capabilities.md)); strong harnesses aren't dragged down,
  weak ones lack the member or refuse the option with a typed error, and
  oar never fabricates structure a runtime doesn't expose
  (see [foundations.md](foundations.md)).
- **The hard problems solved once, with evidence.** Session resume,
  sub-agent and token attribution, version-skew safety (works inside the
  support window, typed rejection outside, never silently wrong).
- **Nothing lost.** Because the producer is lossless, native payloads remain
  reachable, so using oar doesn't wall you off from harness-specific power.

## When oar lacks something

oar connects each runtime through an interface its own vendor ships and
maintains (an app-server, a structured headless protocol, an SDK, or the
vendor's own ACP server), never a third-party adapter
([decision](decisions.md#reaching-a-runtime-through-another-hosts-adapter-2026-10-05)).
A missing capability is then either a gap in oar's mapping or a limit of
the interface oar uses for that runtime, and the runtime page says which.
Kimi shows the second kind: its Node SDK can steer a running turn, `kimi acp`
has no steer method, so oar's Kimi session has no `steer`
([kimi](../runtimes/kimi.md)). There are two ways to close either kind of gap:

- **Ask.** Closing it changes one adapter and, where needed, the shared
  contract, in one repository, released on oar's own schedule. That includes
  moving an adapter to a different vendor interface, such as Kimi's Node SDK.
  A capability defined by a cross-vendor protocol depends on the protocol,
  each agent's implementation and their releases, unless a vendor adds its
  own extension.
  Steering a running turn, for example, was proposed for ACP in May 2026
  ([discussion #1220](https://github.com/orgs/agentclientprotocol/discussions/1220),
  [RFD PR #1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261))
  and is still unmerged as of 2026-10-29; the
  [v2 prompt lifecycle RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/v2/prompt.mdx)
  explicitly leaves queueing and steering out.
- **Fork.** The contract, every adapter, the behavior suites and the evidence
  live in one repository. A team that needs a native capability now can
  change the adapter and ship its own build, with no separate protocol layer,
  agent-side driver or driver installation to change.

oar is meant to be the developer's last stop: the one place where a runtime
is integrated, by us or by whoever forks it.

## The honest boundary

If an application uses exactly one harness and its native SDK fits, direct
use is fine. oar pays off at two or more runtimes, or at one, when you want
durability against harness churn and someone else to have already absorbed
each vendor's quirks.
