# Development

How to work in this repo: how to run the tests, where each kind of test
lives, the assertion conventions, and the commit gate. Linked from the root
`README.md` index.

Deeper detail lives next to the code it describes:
[`packages/oar/src/README.md`](../packages/oar/src/README.md) for the source
layout, import rules, and ownership;
[`sea-trial/README.md`](../sea-trial/README.md) for the behavior-suite layout
and harness; [`experiments/README.md`](../experiments/README.md) for live
probes and their conclusions.

## How to test

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

There are several ways to run tests because each answers a different
question at a different cost. Run the cheapest one that can catch the
mistake you might just have made, escalate as the change gets riskier, and
finish with the full gate:

```bash
pnpm test                                    # unit tests (vitest)
pnpm sea-trial                               # behavior suite on the in-process mock
OAR_TEST=pi-aimock pnpm sea-trial            # behavior suite on one backend
OAR_TEST=pi-aimock pnpm vitest run sea-trial/vendor   # vendor tests for that backend
pnpm tsx sea-trial/all.ts                    # mock + all three aimock backends concurrently
pnpm run check                               # the full commit gate (see below)
```

`OAR_TEST` selects the backend (`sea-trial/harness/backends.ts`). When and
why to reach for each rung:

- `pnpm test` — is the pure logic right (folds, resolvers, process
  plumbing)? Seconds, no binaries. The inner loop while iterating on shared
  mechanisms.
- `pnpm sea-trial` — does the public contract still hold? Runs the behavior
  suite against the in-process mock fixture: fast, deterministic, no
  binaries or network. The default verification for any change to contracts
  or session behavior.
- `OAR_TEST=<runtime>-aimock pnpm sea-trial` (`claude-aimock` /
  `codex-aimock` / `pi-aimock`) — same contract, but through the real vendor
  binary and adapter, with only the model provider scripted; no login
  needed. Use when you touched a specific runtime's adapter — it catches
  real-process integration mistakes the mock cannot.
- `OAR_TEST=<runtime>-aimock pnpm vitest run sea-trial/vendor` — the vendor
  tests see the scripted provider's side (request contents, error edges,
  tool rounds). Use when your change affects what a runtime sends upstream
  or how it handles vendor-specific behavior.
- `pnpm tsx sea-trial/all.ts` — mock plus all three aimock backends
  concurrently. Use before pushing a change to shared runtime machinery, to
  prove no backend regressed.
- `OAR_TEST=<real id>` (`claude`, `codex`, `grok`, `kimi`, `pi`) — the same
  suites against your actual local installation and login. The final word
  when vendor reality itself is in doubt, but it costs quota — run
  deliberately, never by default.

`pnpm run check` is the gate for every commit: coxswain check, typecheck,
lint, unit tests, and the mock behavior suite. Vendor tests are not part of
it — run them for the backend you touched.

## The test estate — four kinds, where each goes

| Kind | Lives in | Runs via | Write one when |
|---|---|---|---|
| Unit | `tests/*.test.ts` | `pnpm test` (vitest) | Pure logic and shared mechanisms: folds, resolvers, process plumbing. Virtual time via `vi.useFakeTimers` (mock `Date` too when clocks matter). |
| Behavior | `sea-trial/cases/` | `OAR_TEST=<backend> pnpm sea-trial` | A contract promise every runtime must honor. Assert ONLY through the public Session API — the case must pass on real logins, aimock backends, and the mock fixture alike. Race-honest where runtimes may legitimately differ. |
| Vendor | `sea-trial/vendor/*.vendor.test.ts` | `OAR_TEST=<backend> pnpm vitest run sea-trial/vendor` | Anything needing the scripted provider's view (request contents, error edges, scripted tool rounds) or vendor-specific triggers. Gated with `describe.skipIf(OAR_TEST !== ...)`; helpers in `vendor/support/`. |
| Experiment | `experiments/` | `pnpm tsx experiments/<name>.ts` | A live probe answering one question about a real runtime, kept as evidence with its conclusion in the README table. Not run in CI. |

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
