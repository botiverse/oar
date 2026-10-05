# Development

For system-level changes, start with [`docs/design/system.md`](design/system.md)
and [`docs/design/roadmap.md`](design/roadmap.md), and state which agent
decision gets cheaper or more accurate, which layer owns the change, and which
durable artifact lets the next worker continue. Read
[`docs/design/`](design/README.md) before changing a public surface or
revisiting a design decision, and [`docs/spec/`](spec/README.md) when a change
touches the record-stream contract (record shapes, attribution, the session
graph, the cursor). When working on an adapter, read its
[runtime page](runtimes/README.md) (native API inputs and results, resume
semantics, current OAR mapping, evidence gaps) and update it when the mapping
changes.

Detail lives next to the code:
[`packages/oar/src/README.md`](../packages/oar/src/README.md) (source layout,
import rules, ownership), [`sea-trial/README.md`](../sea-trial/README.md)
(behavior-suite layout and harness),
[`experiments/README.md`](../experiments/README.md) (live probes and their
conclusions).

## Ad-hoc runs while developing

Run first, test second: while shaping a change, run the real thing and look.
Drive the CLI (`pnpm oar ...` builds and runs the in-repo `oar`):
`oar run <runtime> "<prompt>"` shows a turn's progress live, `--record <file>`
keeps the run as an `oar-voyage/3` JSONL log, and `oar list`,
`oar installation <id>`, `oar usage <id>` and `oar models <id>` cover the
observation surfaces. Or point a scratch `pnpm tsx` script at the public
Session API, or reuse an experiment. This is how you find out what correct
looks like before pinning it.

When the check you need has no tool (a CLI flag, a script that replays a
recorded run), build it or extend the oar CLI as part of the change: a command
someone else can rerun turns "trust me, I checked" into "run this and see".

- **Ad-hoc evidence never closes a change.** Once the behavior is understood,
  encode it at the cheapest test layer that can catch a regression (below);
  the commit gate stays the arbiter.
- **Leave the lever behind.** A scratch script that earned its keep becomes a
  test, or an experiment with its conclusion recorded, not a loose file. A
  tool you built or extended for the run is polished and committed with the
  change.
- **Leave a handoff.** For work that spans turns or owners, record the runtime
  identity, cursor or artifact, current conclusion, and next action. A status
  message without a continuation is not an accumulated result.
- **Real logins cost quota.** Repeatable ad-hoc runs belong on the mock or
  aimock backends; use a real installation deliberately, as with
  `OAR_TEST=<real id>`.

## How to validate the changes

Setup: Node.js 24+, `pnpm install`.

The tests let whoever makes a change, human or coding agent, verify it end to
end without a person as the bottleneck: a change is done when the tests prove
it, not when someone has eyeballed it. The suite is also the proof that the
contracts hold on every runtime, so never weaken an assertion to get past a
failure: a red test means the work is not done.

Each layer below validates a different part of a change at a different cost.
Run the cheapest one that can catch your likely mistake, escalate as the
change gets riskier, and finish with the commit gate.

### Unit: is the pure logic right?

`tests/**/*.test.ts` (per-runtime subdirectories included), run by `pnpm test`
(vitest). Seconds, no vendor binaries. The inner loop for shared mechanisms:
folds, resolvers, process plumbing. Use virtual time via `vi.useFakeTimers`
(mock `Date` too when clocks matter).

### Behavior: does the public contract still hold?

One suite in `sea-trial/cases/`, run against interchangeable backends that
`OAR_TEST` selects (`sea-trial/harness/backends.ts`; unset means `mock`, an
unavailable runtime skips). Write a case for a contract promise every runtime
must honor: it asserts only through the public Session API and must pass on
the mock, the aimock backends and real logins alike, race-honest where
runtimes may legitimately differ.

- `pnpm sea-trial`: the in-process mock fixture. Fast, deterministic, no
  binaries or network; the default validation for any change to contracts or
  session behavior.
- `OAR_TEST=<runtime>-aimock pnpm sea-trial` (`claude-aimock`, `codex-aimock`,
  `pi-aimock`): the real vendor binary and adapter with only the model
  provider scripted, no login. Use it when you touched a runtime's adapter: it
  catches real-process integration mistakes the mock cannot.
- `OAR_TEST=scripted pnpm sea-trial`: the public `scriptedRuntime`
  (`@botiverse/oar/testing`) held to the same contract.
- `pnpm tsx sea-trial/all.ts [backend...]`: several backends concurrently,
  by default mock plus the three aimock backends. Use it before pushing a
  change to shared runtime machinery.
- `OAR_TEST=<real id>` (`antigravity`, `claude`, `codex`, `cursor`, `grok`,
  `kimi`, `pi`): your local installation and login. The final word when
  vendor reality is in doubt; it costs quota, so never run it by default.

### Vendor: is the runtime-specific integration right?

`sea-trial/vendor/*.vendor.test.ts`, run by
`OAR_TEST=<runtime>-aimock pnpm vitest run sea-trial/vendor`. Vendor tests see
the scripted provider's side: request contents, error edges, scripted tool
rounds. Run them when a change affects what a runtime sends upstream or how it
handles vendor-specific behavior; write one for anything that needs the
provider's view or a vendor-specific trigger. Each is gated with
`skipIf(process.env.OAR_TEST !== ...)`; helpers live in
`sea-trial/vendor/support/`.

### Experiment: what does the real runtime actually do?

`experiments/`, run by `pnpm tsx experiments/<name>.ts`. A live probe that
answers one question about a real runtime, kept as evidence with its
conclusion indexed in the experiments README. Not run in CI and not part of
validating a change; reach for one when the vendor's actual behavior is the
open question.

### Live: does the strong claim hold on the real runtime?

The shared cases assert the minimum every backend must honor. The strong
claims (a steer lands in the same turn, a queued input runs as its own turn,
an abort ends with the runtime's own report, a killed process shows up as an
`exited` response, sub-agent frames attribute) need a real login:
[`experiments/live-contract.ts <runtime>`](../experiments/live-contract.ts)
writes one voyage log per scenario plus a `report.json` of observed facts
under `oar-trial-run/live-<runtime>-*/`. It burns tokens; run it when an
adapter changes what the stream carries, and record the observation in the
runtime's page and the experiments README.

### The commit gate

`pnpm run check` must be green before every commit: typecheck, lint,
`pnpm test` and the mock behavior suite. Vendor tests are collected by
`pnpm test` but skip unless `OAR_TEST` names their backend, so run them for
the backend you touched. Rebase on origin/main before pushing.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) skips a push
or pull request whose changes are all Markdown files or under `docs/` or
`assets/`. Otherwise it runs three jobs:

- `check`: `pnpm run check` and `pnpm run build` on Linux, macOS and Windows.
- `behavior`: per aimock backend on the same three systems,
  `pnpm run sea-trial` plus that backend's vendor tests.
- `clean-install`: `pnpm run clean-install`
  ([`tests/clean-install.ts`](../tests/clean-install.ts)) on Linux. Both
  packages are packed and `npm install`ed into an empty project: without the
  optional peer `@cursor/sdk`, OAR must load, type-check and probe every
  built-in runtime, and the line that adds cursor must fail the host's
  compile; with the SDK added, cursor loads. The CLI, installed after the
  host's SDK is removed again, lists cursor's models through the SDK it
  depends on itself. It needs the npm registry.

Windows Codex behavior jobs forward child stderr to the job log with
`OAR_CHILD_STDERR=inherit`, including failures before a session trace exists.
Artifact upload warns when no trace directory was created; the failed test
or startup step still fails the job. Codex RPC exit errors also retain a
bounded stderr tail without this setting, so use that evidence before
changing a timeout or assertion to address an intermittent startup failure.
Installation readiness and `--version` execution failures retain the native
error, signal, timeout, exit code and stderr tail in their exception too.

## How to add a new runtime

1. **Probe reality first.** Write an experiment that answers how the vendor
   actually behaves (session lifecycle, event stream, error shapes) and index
   its conclusion in the experiments README. Build the adapter on that
   evidence, not on the vendor's docs.
2. **Implement it in `packages/oar/src/runtimes/<id>/`.** `index.ts` declares
   the runtime with `defineRuntime({ id, ... })`, listing only the
   capabilities the runtime honestly supports: an absent capability is
   correct, a faked one is not. The session adapter feeds a
   `createSessionKernel()`:
   - every native frame becomes exactly one `Frame` record via
     `kernel.frame()` (`type`, `native` verbatim, `events` holding the
     `RuntimeEventBody`s oar reads from it), never gated on turn state, never
     dropped, never synthesized; the shared `eventsOf` derives the flat
     `Session.events()` surface from those records, so an adapter never
     builds it;
   - control calls go through `kernel.control()` so request and response are
     records;
   - the process exit is an `exited` response;
   - a whole operation the runtime cannot do is a member the session lacks:
     no `steer` on a runtime that cannot inject, never a `steer` that always
     rejects; `capabilities` declares queue durability, the attribution tier
     and image input as the runtime actually exposes them;
   - an option the runtime cannot honor is refused at open with an
     `UnsupportedOptionError`, never dropped; one it refuses whenever given
     is declared in `refusedSessionOptions` and checked by
     `refuseSessionOptions`, so the declaration and the refusal agree.

   Keep the projection a pure fold (frame → commands) so replay tests
   (`tests/replay/`, fixtures captured by `pnpm sea-trial:record`) can pin
   it. Keep parsing, compatibility policy and protocol details in that
   directory; reuse `shared/` mechanisms freely but never add runtime
   identity to `shared/` ([source layout](../packages/oar/src/README.md) has
   the import rules).
3. **Register it in `src/index.ts`**, the only composition root: import, add
   to the built-in `defaultRuntimes` registry, re-export. Give it a `runtimeBrands`
   entry in `src/brands.ts` with its SVG in `packages/oar/assets/brands/`
   (attribution in `NOTICE.md`). A runtime that needs something the host
   installs (cursor's SDK) is not built in: export its constructor instead,
   and add it to `allRuntimes` in `sea-trial/harness/runtimes.ts` and to the
   CLI's registry in `packages/cli/src/runtimes.ts`
   ([capabilities](design/capabilities.md#a-runtimes-own-settings)).
4. **Make the behavior suite pass unchanged.** `OAR_TEST=<id> pnpm sea-trial`
   against your real local installation. The cases in `sea-trial/cases/` are
   the contract: make the runtime pass them, don't loosen them to fit. A case
   that needs a capability skips on its absence (a session without `steer`),
   never on a runtime name.
5. **Add an aimock backend if feasible** (`sea-trial/harness/aimock.ts`,
   `backends.ts`, and the `behavior` matrix in `.github/workflows/ci.yml`) so
   the contract stays verifiable without a login, and add vendor tests for the
   provider-side specifics worth pinning.
6. **Update the docs in the same commit**: the runtime lists in the root and
   `packages/oar` READMEs, a [runtime page](runtimes/README.md) and its index
   entry, and the experiments README for any probes you added. The runtime
   page starts with the vendor's programming interface and concepts, then maps
   each capability to OAR or names the missing support and evidence.

## How to fix a runtime bug

1. **Locate the layer; that picks the test.** Wrong behavior visible through
   the public Session API: a behavior case (if every runtime must honor the
   promise). A wrong request sent to the vendor, or a mishandled
   vendor-specific edge: a vendor test. A pure-logic mistake in a fold or
   resolver: a unit test.
2. **If the vendor's actual behavior is the open question, probe it first**
   with an experiment and record the conclusion; don't derive the fix from
   documentation guesses.
3. **Write the failing test before the fix**, at the cheapest layer that can
   express it. `OAR_TEST=<runtime>-aimock` reproduces most integration bugs
   without a login.
4. **Fix at the right level.** Runtime-specific policy belongs in
   `runtimes/<id>/`; touch `shared/` only when the mistake is genuinely
   runtime-independent, and then run `pnpm tsx sea-trial/all.ts`, because
   every backend is affected.
5. **Validate up the layers and finish with `pnpm run check`.** The
   reproducing test stays in the suite as the regression proof.
6. **Update the runtime page** when a bug changes the documented native
   behavior, OAR mapping or verification status. Distinguish the vendor's
   behavior from loss or policy introduced by OAR.

## Testing conventions

- **Assert, don't `if + throw`.** Checks use `node:assert/strict` (or vitest
  `expect`), inside behavior cases and vendor tests too. Shared narrowing
  helpers (`promptTurn`, `expectAvailable`) live in
  `sea-trial/vendor/support/asserts.ts`.
- **Snapshot value shapes.** When asserting what a value looks like (an
  outcome object, an event sequence, a fold result), pin the whole thing with
  `toMatchInlineSnapshot`; no substring checks like `reason.includes("400")`.
  Snapshots update on local runs and are enforced when `CI` is set
  (`vitest.config.ts`: update `none`). Keep plain assertions for logic and
  invariants (ordering, ranges, idempotence).
- **Test layer = assertion channel.** What the public Session API shows goes
  in a behavior case that runs on every backend; anything that needs the
  scripted provider's view (request contents, error edges, vendor
  fingerprints) or a vendor-specific trigger goes in a vendor test.
- **Failures must self-diagnose.** Include the actual value in the assertion
  message; long-running suites write traces and artifacts under
  `oar-trial-run/`.

## How to release

Both packages carry one version. A release is a pull request
(`chore: release vX.Y.Z`) that only sets `version` in
`packages/oar/package.json` and `packages/cli/package.json`. Squash merge
it, then put an annotated tag on the merged commit and push the tag:

```bash
git fetch origin
git tag -a vX.Y.Z -m vX.Y.Z origin/main
git push origin vX.Y.Z
```

The tag push starts
[`.github/workflows/release.yml`](../.github/workflows/release.yml): it
refuses a tag that differs from either package version, runs
`pnpm run check` and `pnpm run build`, and publishes both packages with
`pnpm -r publish`, which rewrites the CLI's `workspace:*` dependency to the
real version. npm trusted publishing (OIDC) authenticates the job; the repo
holds no npm token.
