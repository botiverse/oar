# Introducing oar: one contract for driving agent runtimes

> **Status: DRAFT — prepared ahead of the design freeze.** The motivation
> and the shipped surface described here are settled. Anything about the
> record stream is a draft under review; those paragraphs are marked
> **[not finalized]** and must be re-read against
> [`docs/spec/`](../spec/README.md) before this post is published.

oar is a TypeScript library and CLI that lets an application drive several
coding-agent runtimes — Claude Code, Codex, Grok, Kimi, and Pi today — through
one contract: detect the installation, list the models it can run right now,
read account usage, open a session, prompt it, steer or queue input, watch the
event stream, read context usage, resume later. Everything the runtime says is
kept, nothing the runtime did not say is invented, and what a runtime cannot do
is reported as a typed `unsupported` instead of being faked.

Packages: `@botiverse/oar` (library) and `@botiverse/oar-cli` (the `oar`
executable). Current release: v0.0.9. ESM-only, Node.js 24 or newer,
Apache-2.0. Source: <https://github.com/botiverse/oar>.

## The problem

Every harness ships its own private access mechanism: an SDK, an app-server,
an ACP variant, a subprocess stdio protocol, an in-process library. Each comes
with its own session model, event vocabulary, usage reporting, config, install
and login story. A product that embeds more than one runtime writes N
integrations, and each one is lossy or ad hoc in its own way.

The deeper problem is that the genuinely hard parts are protocol problems —
a lossless attributed event stream, session identity and resume, sub-agent
association, token attribution, capability differences — and every
application currently reinvents them privately. We have concrete evidence
that this goes wrong: one vendor's own protocol adapter drops its sub-agent
events; another exposes overlapping usage views that cannot be summed.
Vendors' own remote-control stacks (app-server modes, serve and leader modes,
remote-control protocols) are each a private, single-runtime version of the
same protocol, which confirms the problem is real and general.

## The bet

oar is a bet on where innovation concentrates: **the larger innovation
happens at the application layer, not the harness layer.** Coding-agent
runtimes are converging on session models, event streams, sub-agent patterns
and usage reporting, and the differences that remain are the kind a protocol
can absorb. Applications are where the design space is still wide open: UX
for the humans, and AX (agent experience) for the agents themselves.

The practical consequence is that an application should be able to invest in
UX and AX without caring how a concrete task is run. That is the harness's
concern, and oar's job is to keep it there. This is not an argument for
hiding the runtime: oar must expose enough surface to *control* it — drive
sessions, steer and cancel, read capabilities, reach native payloads — so
that abstraction never costs control.

If the bet is wrong and harnesses diverge instead, the lossless producer and
per-runtime capability declarations are the hedge: nothing a runtime exposes
is walled off.

## Integrating a runtime is harder than it looks

"Integrate" hides fifteen distinct problems, and we discovered almost every
one of them the hard way with a concrete runtime as the counterexample. A few
of them:

- **Reaching the runtime at all.** One vendor often ships several access
  mechanisms with different capabilities. Detecting the binary, installing
  it, and knowing which version you got matters because behavior changes
  between versions. Our CI matrix caught three Windows-only bugs
  that never appear on Linux or macOS.
- **Session identity and resume are not universal.** Claude session ids,
  Codex resume that replays full history, Pi forks (transcript branches, not
  sub-agents), Grok's session load replay: "the same session" means something
  different in each.
- **Event vocabularies share no semantics.** Turn boundaries are genuinely
  absent or partial in some runtimes. Synthesizing them yourself is a trap:
  our v1 did it and we ripped it out.
- **Attribution is the most underestimated part.** Sub-agent exposure spans a
  spectrum from opaque (Kimi's own ACP adapter drops sub-agent events)
  through attributed (Claude and Codex via `parent_tool_use_id`) to fully
  nested child sessions (Grok). Usage accounting is cumulative in one
  runtime, a delta in another, and in the worst case several overlapping
  views that must not be summed.
- **Vendor quirks only show up empirically.** A silent retry loop on 401, a
  400 error arriving with subtype `"success"`, a serve mode that silently
  discards notifications when no client is attached. Documentation does not
  tell you this; only tests against real behavior pin it down.

The full inventory, each with its real-runtime counterexample, is in
[`docs/design/hard-problems.md`](../design/hard-problems.md).

## Dirty work versus foundations

Not all of those problems deserve the same care. The dividing test we use:

> Can a mistake here be fixed later without breaking what is built on top?

Install, detect, auth, OS quirks and config forms are dirty work. They are
stateless: get one wrong, fix the bug, nothing downstream changes. It is
valuable to have this solved once, but any mistake stays local.

Losslessness, session identity and cursor, sub-agent and usage attribution,
the separation of facts from control, and capability honesty are
foundations. A wrong early decision there gets encoded into the application's
own data model and compounds. Dropped or synthesized events are gone or fake
forever. Wrong attribution makes recorded history wrong forever. Faked
capability support means application logic is written against lies, and the
correction is a breaking change for the consumer, not for us.

Liveness belongs on the foundation list too. "Is this agent alive or dead,
and why" is really three questions (is the process alive, is the session
progressing, and why is it stuck), and the natural implementation —
inferring death from silence — is where multi-agent applications rot. oar's
position is that death should be a recorded fact in the stream, not a
timeout guess, and that when a runtime is silent we report what we observed
and declare the rest unknown rather than synthesizing a heartbeat.
[`docs/design/foundations.md`](../design/foundations.md) and
[`docs/design/liveness.md`](../design/liveness.md) have the reasoning.

## What ships today

The contract is small and the same for every runtime: one ordered record
stream per session, and control actions that are themselves records in it.

```ts
import { promptAndWait, runtimes } from "@botiverse/oar";

const grok = runtimes.require("grok");
const installation = await grok.installation?.();

if (installation?.kind === "available") {
  const session = await grok.session(installation, { cwd: process.cwd() });
  session.subscribe((record) => {
    // record.kind: "event" (the runtime's frame, verbatim, plus oar's views),
    // "request" (prompt/steer/abort/dispose, or the runtime asking the app),
    // "response" (accepted/rejected, oar's answer, the process exit)
  });
  const run = await promptAndWait(session, "Inspect this repository");
  console.log(run.kind === "ended" ? run.outcome : run.reason);
  console.log(session.usage(), await grok.accountUsage?.(installation));
  await session.dispose();
}
```

- **Five runtimes** behind one registry: `claude`, `codex`, `grok`, `kimi`,
  `pi`. Grok and Kimi share a private ACP transport internally but are
  distinct public runtimes; there is deliberately no generic "acp" runtime,
  because the vendors differ in exactly the places that matter.
- **Two optional, independent capabilities besides sessions.**
  `runtime.installation()` answers local install and version questions
  without any account I/O. `runtime.accountUsage(installation)` reads
  credentialed usage. A runtime that lacks one simply does not declare it.
- **`runtime.listModels(installation)`** returns the models an installation
  can run *right now*, taking login state, plan and configured providers
  into account, as a typed `ok | unauthenticated | unsupported` result. Each
  entry carries the id you pass back as `model`, plus the resolved id,
  display name and effort levels when the runtime reports them.
- **Sessions with one active turn**, an explicit `steerOrQueue` that reports
  where mid-turn input landed (steered into the running turn, or queued for
  the next), `abort` on the turn handle, and `dispose`. `resume` reopens a runtime-native session
  by its id, optionally with a different model.
- **Read-backs, not echoes.** `session.model()` reports the model the
  runtime says is in effect, which a resume or model switch can silently
  leave unchanged. `session.contextUsage()` is the runtime's latest context
  snapshot and is honestly `null` right after compaction.
- **A lossless event stream.** Unknown runtime events are preserved and
  passed through; the native payload stays reachable.
- **Embedded by default.** Sessions run without interactive permission gates
  and without a sandbox unless the host opts in, because in embedded use
  nobody is sitting at an approval prompt and a gate is a hang, not safety.

The CLI covers the same surface for people:

```bash
npx @botiverse/oar-cli list
oar installation codex
oar usage claude
oar models pi
oar run claude "What does this repo do?"
oar run codex "Summarize the tests" --record run.jsonl
```

`oar run --record` writes the whole run as an `oar-voyage/2` JSONL log: a
header, every record of the stream verbatim (the runtime's frames, the
prompt and every other control action, their answers), and an end
marker. We use it as the unit of evidence: a claim about runtime behavior
points at a log anyone can read, and a failed or aborted turn is a finding,
not something to retry until it looks clean.

## How we keep ourselves honest

Every non-obvious claim about a runtime is pinned by a script under
[`experiments/`](../../experiments/README.md) that runs against the real
runtime or its pinned upstream source, with an `OBSERVED` header recording
the date and version. When a runtime's behavior surprised us, the fix shipped
with the experiment that reproduces it. Examples from the last month: Codex
drops a model override on resume when the connection is already subscribed
to that thread; Kimi answers a prompt before it pushes the turn's usage
update; Pi's model registry is empty until an availability refresh runs.

Design and contract live in the repository, deliberately split.
[`docs/design/`](../design/README.md) records *why* a position holds.
[`docs/spec/`](../spec/README.md) records *what* the contract is. Both
change in the same commit as the code that changes them.

## What is not finalized

The shipped API is the v2 record stream: one ordered, resumable stream in
which records split into event, request and response, every record
self-attributes (session id plus agent path), and a monotonic sequence
number is the cursor. Every frame a runtime emits is in the stream
verbatim; oar's typed reading of it rides alongside as views. The full
contract is in [`docs/spec/`](../spec/README.md), together with the one
designed half that is **not shipped**: rebuilding a stream after the
adapter process died, with the same sequence numbers, from the runtime's
own replay log. Today resume reopens the runtime-native conversation with a
fresh stream.

**[not finalized]** Three points remain explicitly open: whether the
deleted causal-link field between records stays deleted; how external
compaction (a new session seeded with a summary) is represented without lying
about lineage; and a fuller typed capability declaration per adapter beyond
steer, queue durability and the attribution tier declared today.

Cross-runtime sub-agent attribution ships with the tier each adapter
declares: Claude attributes sub-agent frames through the Task call that
spawned them; Codex and Grok record child threads and sessions as sessions
of their own in the graph; Kimi's ACP surface shows only the main agent and
the adapter says so rather than fabricating children; Pi has none. The
adapter red line (degrade to opaque only when the runtime truly lacks the
information, never because the adapter did not wire it up) is now what the
shared behavior suite and each adapter's declaration enforce. What remains
unverified live — child usage attribution on Claude, Grok's vendor
lifecycle notifications — is marked as such in the runtime pages.

Explicit non-goals, which are settled: multi-language bindings, and being a
storage or replay system. oar emits the complete attributed stream;
derivation and persistence stay the consumer's business.

## When you do not need oar

If an application uses exactly one harness and its native SDK fits, direct
use is fine. oar pays off at two or more runtimes, or at one when you want
durability against harness churn and someone else to have already absorbed
each vendor's quirks.

## Try it

```bash
npx @botiverse/oar-cli list
```

Library: `pnpm add @botiverse/oar`. Issues and design discussion:
<https://github.com/botiverse/oar>. Start with
[`docs/design/motivation.md`](../design/motivation.md) if you want the
reasoning before the code.
