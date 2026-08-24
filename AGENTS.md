# Working in this repo

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
