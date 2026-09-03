# Development

How to work in this repo: how to validate your changes, how to add a
runtime or fix a runtime bug, the testing conventions, and the commit gate.
Linked from the root `README.md` index.

Deeper detail lives next to the code it describes:
[`packages/oar/src/README.md`](../packages/oar/src/README.md) for the source
layout, import rules, and ownership;
[`sea-trial/README.md`](../sea-trial/README.md) for the behavior-suite layout
and harness; [`experiments/README.md`](../experiments/README.md) for live
probes and their conclusions.

The other two indexed docs are background, not required reading for routine
changes: read [`docs/design/`](design/README.md) before changing a public
surface or revisiting an existing design decision — it explains why oar is
shaped the way it is; read [`docs/spec/`](spec/README.md) when a change
touches the v2 record-stream contract (record shapes, attribution, the
session graph, the cursor).

## How to validate the changes

Setup: Node.js 24+, `pnpm install`.

The tests exist so that whoever makes a change — human or coding agent — can
also verify it, end to end, on their own: run the relevant test, read the
failure, fix, rerun, and keep going until green. A change is done when the
tests prove it, not when a human has eyeballed it; that is what lets work
proceed without a person as the verification bottleneck. The suite carries a
second load: it is the proof that oar's foundation is solid — that the
contracts actually hold on every runtime. Both loads collapse if the tests
stop being trusted, so never weaken an assertion to get past a failure. A
red test means the work is not done, not that the test is in the way.

There are four kinds of tests. Each validates a different layer of a change
at a different cost; run the cheapest kind that can catch the mistake you
might just have made, escalate as the change gets riskier, and finish with
the commit gate.

### Unit — is the pure logic right?

Lives in `tests/*.test.ts`; runs via `pnpm test` (vitest). Seconds, no
binaries. The inner loop while iterating on shared mechanisms: folds,
resolvers, process plumbing. Write one for pure logic; virtual time via
`vi.useFakeTimers` (mock `Date` too when clocks matter).

### Behavior — does the public contract still hold?

One suite in `sea-trial/cases/`, run against interchangeable backends;
`OAR_TEST` selects the backend (`sea-trial/harness/backends.ts`). Write a
case for a contract promise every runtime must honor: it asserts only
through the public Session API and must pass on the mock, the aimock
backends, and real logins alike — race-honest where runtimes may
legitimately differ. Which backend to run, when:

- `pnpm sea-trial` — the in-process mock fixture: fast, deterministic, no
  binaries or network. The default validation for any change to contracts
  or session behavior.
- `OAR_TEST=<runtime>-aimock pnpm sea-trial` (`claude-aimock` /
  `codex-aimock` / `pi-aimock`) — same contract, but through the real vendor
  binary and adapter, with only the model provider scripted; no login
  needed. Use when you touched a specific runtime's adapter — it catches
  real-process integration mistakes the mock cannot.
- `pnpm tsx sea-trial/all.ts` — mock plus all three aimock backends
  concurrently. Use before pushing a change to shared runtime machinery, to
  prove no backend regressed.
- `OAR_TEST=<real id>` (`claude`, `codex`, `grok`, `kimi`, `pi`) — your
  actual local installation and login. The final word when vendor reality
  itself is in doubt, but it costs quota — run deliberately, never by
  default.

### Vendor — is the runtime-specific integration right?

Lives in `sea-trial/vendor/*.vendor.test.ts`; runs via
`OAR_TEST=<runtime>-aimock pnpm vitest run sea-trial/vendor`. Vendor tests
see the scripted provider's side — request contents, error edges, scripted
tool rounds. Run them when your change affects what a runtime sends
upstream or how it handles vendor-specific behavior; write one for anything
that needs the provider's view or a vendor-specific trigger. Gated with
`describe.skipIf(OAR_TEST !== ...)`; helpers in `vendor/support/`.

### Experiment — what does the real runtime actually do?

Lives in `experiments/`; runs via `pnpm tsx experiments/<name>.ts`. A live
probe answering one question about a real runtime, kept as evidence with
its conclusion in the README table. Not run in CI and not part of
validating a change — reach for one when the vendor's actual behavior is
the open question.

### The commit gate

`pnpm run check` is the gate for every commit: coxswain check, typecheck,
lint, unit tests, and the mock behavior suite. Vendor tests are not part of
it — run them for the backend you touched.

## Ad-hoc runs while developing

Not every check starts life as a test. While shaping a change it is often
fastest to run the real thing and look: drive the CLI (`oar list`,
`oar installation <id>`, `oar usage <id>`), point a scratch `pnpm tsx`
script at the public Session API, or reuse an experiment. This ad-hoc
run-and-verify loop is a legitimate part of development — it is how you
find out what correct even looks like before pinning it.

Two rules keep it honest:

- **Ad-hoc evidence never closes a change.** Once the behavior is
  understood, encode it at the cheapest test layer that can catch a
  regression (the ladder above); the commit gate stays the arbiter. A
  scratch script that earned its keep becomes a test — or an experiment
  with its conclusion recorded — rather than a loose committed file.
- **Real logins cost quota.** Repeatable ad-hoc runs belong on the mock or
  aimock backends; reach for a real installation deliberately, the same
  way `OAR_TEST=<real id>` is reserved for when vendor reality is in
  doubt.

## How to add a new runtime

1. **Probe reality first.** Write an experiment (`experiments/`) that answers
   how the vendor actually behaves — session lifecycle, event stream, error
   shapes — and record the conclusion in the experiments README table. The
   adapter gets built on that evidence, not on the vendor's docs.
2. **Implement it in `packages/oar/src/runtimes/<id>/`.** `index.ts` declares
   the runtime via `defineRuntime({ id, ... })`, listing only the
   capabilities the runtime honestly supports — an absent capability is
   correct, a faked one is not. Keep parsing, compatibility policy, and
   protocol details in that directory; reuse `shared/` mechanisms freely but
   never add runtime identity to `shared/`
   ([source layout](../packages/oar/src/README.md) has the import rules).
3. **Register it in `src/index.ts`** — the only composition root: import,
   add to the built-in registry, re-export.
4. **Make the behavior suite pass unchanged.** `OAR_TEST=<id> pnpm sea-trial`
   against your real local installation. The cases in `sea-trial/cases/` are
   the contract: make the runtime pass them, don't loosen them to fit the
   runtime.
5. **Add an aimock backend if feasible** (`sea-trial/harness/aimock.ts` +
   `backends.ts`) so the contract stays verifiable without a login, and add
   vendor tests for the provider-side specifics worth pinning.
6. **Update the docs in the same commit**: the runtime list in the root
   README, and the experiments README table for any probes you added.

## How to fix a runtime bug

1. **Locate the layer; that picks the test.** Wrong behavior visible through
   the public Session API → behavior case (if it is a promise every runtime
   must honor). Wrong request sent to the vendor, or a mishandled
   vendor-specific edge → vendor test. A pure-logic mistake in a fold or
   resolver → unit test.
2. **If the vendor's actual behavior is the open question, probe it first**
   with an experiment and record the conclusion — don't derive the fix from
   documentation guesses.
3. **Write the failing test before the fix**, at the cheapest layer that can
   express it. `OAR_TEST=<runtime>-aimock` reproduces most integration bugs
   without a login.
4. **Fix at the right level.** Runtime-specific policy belongs in
   `runtimes/<id>/`; touch `shared/` only when the mistake is genuinely
   runtime-independent — and then run `pnpm tsx sea-trial/all.ts`, because
   every backend is affected.
5. **Validate with the ladder above and finish with `pnpm run check`.** The
   reproducing test stays in the suite as the regression proof.

## Testing conventions

- **Assert, don't `if + throw`.** Checks use `node:assert/strict` (or vitest
  `expect`) — including inside behavior cases and vendor tests. Shared
  narrowing helpers (`promptTurn`, `expectAvailable`) live in
  `sea-trial/vendor/env.ts`.
- **Snapshot value shapes.** When asserting what a value LOOKS like (an
  outcome object, an event sequence, a fold result), use
  `toMatchInlineSnapshot` and pin the whole thing — no substring checks like
  `reason.includes("400")`. Snapshots auto-update on local runs and are
  enforced in CI (`CI=true` → update: none). Keep plain assertions for
  logic/invariants (ordering, ranges, idempotence).
- **Test layer = assertion channel.** Behavior cases (`sea-trial/cases/`)
  assert only what the public Session API shows and must run on EVERY
  backend, real logins included. Anything that needs the scripted provider's
  view (request contents, error edges, vendor fingerprints) or vendor-specific
  triggers goes in `sea-trial/vendor/`, gated on the matching `OAR_TEST`
  backend.
- **Failures must self-diagnose.** Include the actual value in the assertion
  message; long-running suites write traces/artifacts (`oar-trial-run/`).

## Verification discipline

Gate every commit: `pnpm run check` green first, then commit+push (rebase on
origin/main before pushing). Behavior backends: `tsx sea-trial/all.ts` runs
mock + the three aimock backends concurrently.
