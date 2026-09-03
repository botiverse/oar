# The hard problems

Integrating an agent runtime is harder than it looks, because "integrate"
hides fifteen distinct problems. Almost every one below was discovered the
hard way, with a concrete runtime as the counterexample. Each looks small
until you multiply by N runtimes and then discover the per-runtime
exceptions — that multiplication is exactly the cost oar absorbs once.

Which of these are routine work and which are load-bearing foundations is the
subject of [foundations.md](foundations.md).

## Just reaching the runtime

1. **Access mechanism heterogeneity.** SDK, CLI, subprocess stdio protocol,
   app-server, ACP variant, in-process library (pi) — even figuring out how
   to drive a harness is per-vendor research, and one vendor often ships
   several mechanisms with different capabilities.
2. **Detect / install / version catalog.** Finding the binary, installing
   it, knowing which version you got — and version skew: behavior changes
   between versions, so you need a support window with typed rejection
   outside it, not silent wrongness.
3. **Auth.** Every harness has its own login flow, credential storage
   location, and expiry behavior.
4. **OS matrix.** Cross-platform process handling is its own bug farm — our
   CI matrix caught three Windows-only bugs (powershell argument resolution,
   `.cmd` spawn EINVAL, teardown races) that never appear on linux/mac.

## The session and event model

5. **Session identity and resume.** What "the same session" means differs:
   claude session ids, codex resume that replays full history, pi forks
   (transcript branches, not sub-agents), grok's session/load replay. Resume
   is not a universal primitive.
6. **Event vocabulary with no shared semantics.** Each harness has its own
   event types; turn/run boundaries are genuinely absent or partial in some
   (pi, claude). The tempting fix — synthesizing boundaries yourself — is a
   trap: v1 did it and we ripped it out. Unknown events must be preserved,
   never dropped.
7. **Deriving status.** "Is it running / waiting for input / done" is a fold
   over events, and it is easy to conflate control flow with fact flow — we
   found five distinct places v1 did this.
8. **Process-death edges.** Kill the process mid-tool-call and you get
   dangling tool calls with no ended/result events — you need explicit
   dispose semantics and post-mortem records, or consumers hang on state
   that will never settle. (See [liveness.md](liveness.md).)

## Attribution — the most underestimated part

9. **Sub-agent association.** Runtimes span a spectrum: opaque (kimi's own
   ACP adapter literally drops sub-agent events), attributed (claude/codex
   via `parent_tool_use_id`), fully nested child sessions (grok). Every
   application privately reinvents association, and the protocol must never
   fabricate structure a runtime doesn't expose.
10. **Token/usage accounting.** Cumulative vs delta, child usage billed to
    parent, and — worst case — multiple overlapping usage views you must not
    sum (grok). Usage facts need provenance and a canonical marker.

## Behavioral honesty

11. **Capability differences.** Features exist on some harnesses and not
    others; you need honest per-runtime declaration with typed
    `unsupported`, not a lowest-common-denominator interface and not faked
    support.
12. **Vendor quirks that only show up empirically.** claude's silent retry
    on 401, a 400 error arriving with subtype `"success"`, grok's serve mode
    silently discarding notifications when no client is attached. Docs don't
    tell you this; only conformance tests against real behavior pin it down
    (see [`../../experiments/README.md`](../../experiments/README.md)).
13. **Cancellation and steering.** Abort vs steer vs interject differ per
    runtime (grok has interject + send_now queueing; others can't steer at
    all), and each interacts with the event stream differently.

## Beyond a single local process

14. **Context management.** Context accounting, native compaction events
    (codex), and supporting external compaction (new session + injected
    prompt) without lying about lineage.
15. **Placement.** Local co-process vs remote service vs managed cloud —
    session, process, and host lifecycle are three different layers, and
    multi-client attach needs a resumable cursor or you get grok-style
    notification loss.
