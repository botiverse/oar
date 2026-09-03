# Development

How to work in this repo: where each kind of test lives, the assertion
conventions, and the commit gate. Linked from the root `README.md` index.

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
