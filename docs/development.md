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
keeps the run as an `oar-voyage/3` JSONL log, and `oar installation <id>`,
`oar account status <id>`, `oar account usage <id>` and `oar models <id>` cover the
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
- **Public evidence must be readable without a login.** Repository docs must
  not rely on private Artifact pages as evidence. Commit the report,
  reproduction script and selected, redacted results under `experiments/`
  and link them with repository-relative paths. Keep raw credentials,
  account identifiers and machine-local paths out of published results.
- **Real logins cost quota.** Repeatable ad-hoc runs belong on the mock or
  aimock backends; use a real installation deliberately, as with
  `OAR_TEST=<real id>`.

## How to validate the changes

Setup: Node.js 24+, `pnpm install`.

`pnpm run typecheck` and both packages' builds use `tsrs`, pinned exactly to
`0.20.0-ts7.1.0-beta` in the root devDependencies (TypeScript 7.1 beta
semantics, not TypeScript 6), locally and in CI. On every tsrs upgrade keep
the pin exact and compare the emitted files, especially declarations and
source maps, against the previous tsrs and the matching official
TypeScript 7 build ([migration evidence](../experiments/tsrs-migration-2026-10-20.md):
timings, comparisons, incremental-cache checks). Native binaries exist for
Linux x64/arm64 (GNU and musl), macOS x64/arm64 and Windows x64; elsewhere
set `TSRS_BINARY` to a locally built compiler or rely on the required CI
checks (there is no automatic tsc fallback). Incremental build caches live
inside `dist` and are excluded from the npm packages; removing `dist` forces
a complete rebuild.

The official `typescript` dependency also parses source for the spawn-boundary
check in `tests/spawn-boundary.test.ts`. `tests/clean-install.ts` checks that a
TypeScript 6 host can consume the packed, tsrs-built declarations. An editor on that workspace TypeScript 6 can report different
diagnostics from CI; tsrs has its own language server
([editor setup](https://github.com/oxc-project/tsrs/blob/main/docs/LSP.md#editor-setup)).
Type-aware lint uses oxlint/oxlint-tsgolint; tsx, esbuild and vitest are
not replaced by tsrs.

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

On Windows, Vitest global setup first runs one real CIM process-table query
(60-second limit), recording total and query duration in the job log and
`oar-trial-run/windows-process-table-preparation.jsonl`; a failed read or
missing observer identity fails setup. This keeps first-use work outside the
unit tests' timing windows. The standalone behavior entry does not prewarm
CIM, so it exercises product preparation and the cold cleanup path under the
15-second disposal assertion. Product preparation and its separate capture
budget: [record contract](spec/record-stream.md#the-rules); cold first-use
timing: [Windows CIM experiment](../experiments/windows-cim/README.md).

Windows cancellation cleanup cases retain bounded, process-local timing
under `oar-trial-run/cancellation-timing`, uploaded as
`windows-cancellation-timing-<shard>` from `check-windows` even on failure. Caller deadlines, query entry
and return, cancellation and post-exit cleanup share one monotonic clock;
local correlation IDs contain no PIDs or process tables. The same capture
covers immediate root exit and kill fallback. Missing or dropped events are
evidence gaps, not proof of zero work. Reproduction and interpretation:
[cancellation phase timing](../experiments/windows-cancellation-timing/README.md). The native cleanup controls
also retain their own cleanup observations and orphan-liveness results. An
unverified Windows exit is accepted only with that operation's recorded
snapshot timeout and matching warning; actual roots must still exit.
[Assertion audit](../experiments/windows-cancellation-timing/assertion-audit.md).

The Pi bash environment and Pi key-command controls also retain
bounded child-process observations in that directory. The test-owned observer
records stage markers, process start/result, elapsed time and allowlisted error
reasons before the native Pi resolver discards a failure. It never records
arguments, environment, paths, output or original error text, and restores the
Node builtin bindings after each test. Missing completion or dropped events
remain evidence gaps. See [the three unresolved Windows controls](../experiments/windows-cancellation-timing/child-startup.md).

### Behavior: does the public contract still hold?

One suite in `sea-trial/cases/`, run against interchangeable backends that
`OAR_TEST` selects (`sea-trial/harness/backends.ts`; unset means `mock`, an
unavailable runtime skips locally; `OAR_TEST_REQUIRE_AVAILABLE=1` makes an
unavailable installation fail). Write a case for a contract promise every runtime
must honor: it asserts only through the public Session API and must pass on
the mock, the aimock backends and real logins alike, race-honest where
runtimes may legitimately differ.

- `pnpm sea-trial`: the in-process mock fixture. Fast, deterministic, no
  binaries or network; the default validation for any change to contracts or
  session behavior.
- `OAR_TEST=<runtime>-aimock pnpm sea-trial` (`claude-aimock`, `codex-aimock`,
  `pi-aimock`, `pi-rpc-aimock`, `pi-durable-aimock`, `qwen-aimock`,
  `grok-aimock`, `kimi-aimock`, `opencode-aimock`, `codebuddy-aimock`,
  `dsh-aimock`, `factory-aimock`, `antigravity-aimock`; Qoder uses `qoder-native`): the real
  vendor binary and adapter with only the model provider scripted, no login. Use it when you touched a runtime's adapter: it
  catches real-process integration mistakes the mock cannot.
- `OAR_TEST=scripted pnpm sea-trial`: the public `scriptedRuntime`
  (`@botiverse/oar/testing`) held to the same contract.
- `pnpm tsx sea-trial/all.ts [backend...]`: several backends, by default
  `mock`, `mock-shared`, `mock-isolated`, every aimock backend except
  `antigravity-aimock`, and Qoder native replay. Run it before pushing a
  change to shared runtime machinery.
  It runs at most `max(1, min(4, floor(availableParallelism() / 2)))`
  backends at once, leaving room for native CLIs' own threads and children,
  and every selected backend runs even after another fails. The bound is
  local only (CI runs backends on separate VMs) and changes no product or
  individual test deadline ([local overload evidence](../experiments/codebuddy-probe-cost/README.md)).
  Pin local native binaries to the CI versions before comparing results (for
  example, `OAR_CODEBUDDY_BIN=/absolute/path/to/2.179.3/codebuddy`): an old
  installation found on PATH is not evidence about the pinned version.
- `OAR_TEST=<real id>` (`antigravity`, `claude`, `codebuddy`, `codex`, `cursor`, `devin`, `dsh`,
  `factory`, `grok`, `kimi`, `opencode`, `pi`, `qoder`, `qwen`): your local installation and login. The final word when
  vendor reality is in doubt; it costs quota, so never run it by default.

### Long runs: does it hold up under real use?

`pnpm harbor` ([apps/harbor](../apps/harbor/README.md)) runs several real
runtimes as long-lived sessions on a shared channel, the way a Raft Computer
hosts agents: work arrives as messages, lands as a prompt, steer or queue, and
sessions are restarted and resumed. A QA agent outside sends real tasks and
watches. Every session keeps a voyage log, and harbor journals deliveries,
turns, exits and findings (stalled turns, failed turns, unexpected exits,
failed resumes, leftover processes) with the record seq that shows each one.
It uses real logins and spends quota; run it on purpose, for hours, not in CI.

### Vendor: is the runtime-specific integration right?

`sea-trial/vendor/*.vendor.test.ts`, run by
`OAR_TEST=<runtime>-aimock pnpm vitest run sea-trial/vendor`. The ACP
runtimes' vendor backends (`opencode-aimock`, `kimi-aimock`, `grok-aimock`,
`antigravity-aimock`, `sea-trial/harness/aimock-acp.ts`; `codebuddy-aimock`,
`sea-trial/harness/codebuddy-aimock.ts`) need the installed CLI; which CI
job runs each is listed under [the commit gate](#the-commit-gate). Vendor
tests see the scripted provider's side: request contents, error edges, scripted tool
rounds. Run them when a change affects what a runtime sends upstream or how it
handles vendor-specific behavior; write one for anything that needs the
provider's view or a vendor-specific trigger. Each is gated with
`skipIf(process.env.OAR_TEST !== ...)`; helpers live in
`sea-trial/vendor/support/`.

The manual [OpenCode snapshot comparison](../experiments/acp-ci-failures/opencode-first-prompt.ts)
retains existing native logs before HOME cleanup under
`OAR_TRIAL_RUN_DIR/native-opencode/`. Retention is bounded to four files and
1 MiB per file, with explicit head/tail gaps and omitted file counts. Normal
fixtures do not copy these logs. Raw logs can contain
session IDs and local paths; publish selected evidence only.
[Diagnostic retention decisions](../experiments/acp-ci-failures/closeout.md)
explain which other observations remain active and why.

The separate Antigravity file-skill comparison uses 1.5.11 from
`.github/antigravity-file-skills.json`, after the 1.5.11 ACP controls.
It compares native `/skills` with the local reader across isolated catalog
fixtures on Linux and macOS, records three file-read timings per stage, and
checks synthetic MCP start markers and signed-out reads. Windows uses a native
fallback control for metadata, builtin initialization and signed-out refusal. Selected results and the repeatable probe
are in [the experiment](../experiments/antigravity-file-skills/README.md).

The Antigravity MCP name-clash vendor case retains failure evidence under
`OAR_TRIAL_RUN_DIR/agy-mcp-failure/` (inside the existing `agy-acp-*` CI
artifact). Before deleting its isolated HOME, it reads up to four native
`antigravity-cli/log/*.log` files, at most 512 KiB from each tail. It also
keeps the echo servers' bounded startup and handshake metadata, without RPC
payloads. Paths, known credentials and credential-bearing native entries
are removed before writing; the manifest identifies missing files and
truncation. Passing cases discard the temporary metadata. Missing startup
records mean startup was not observed, not that no process was launched.
This changes neither the assertion nor the deadline or retry policy.
[Capture validation and replay](../experiments/antigravity-mcp-evidence/README.md).

The Antigravity skill query also writes `antigravity-skills/query-attempt.json`
on failure before deleting its fixture. It retains bounded native output,
truncation flags, the fixture file list and model-request count. Kimi's
concurrent expired-token usage cases write both readers' outcomes and
allowlisted failure labels, fixture HTTP statuses, native local Web statuses,
process count and credential-state booleans. The observations retain no
credential values, request headers or response bodies. Both captures run
before fixture cleanup and preserve the existing assertions and deadlines.


### Experiment: what does the real runtime actually do?

`experiments/`, run by `pnpm tsx experiments/<name>.ts`. A live probe that
answers one question about a real runtime, kept as evidence with its
conclusion indexed in the experiments README. These are not part of the normal
CI change-validation gate; reach for one when the vendor's actual behavior is
the open question. The manual [shared-runtime evidence workflow](../.github/workflows/shared-runtime-evidence.yml)
runs the account-free `experiments/sharing` probes to collect platform
observations, including actual MCP, hook/plugin and tool child cwd and
environment. It preserves failures, retains differences as failures, and
does not admit a runtime to sharing or alter the pull-request gate.

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
`pnpm test` and the mock behavior suite. Vendor tests (`*.vendor.test.ts`)
are excluded by `vitest.config.ts` when `OAR_TEST` is unset, so default
`pnpm test` skips them without importing them; run
`OAR_TEST=<backend> pnpm vitest run sea-trial/vendor` for the backend you
touched. Rebase on origin/main before pushing.

The runtime candidate installer controls use two committed, real npm package
archives with readable sources. They retain four independent installations,
version-match/mismatch assertions and publication checks without packing a
fixture during every test. Each installation checks the extracted files against
the recorded sources. [Fixture preparation](../.github/fixtures/runtime-install/README.md)
keeps npm-pack timing and failure diagnostics outside the installer deadline.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) skips a push
or pull request whose changes are all Markdown files or under `docs/` or
`assets/`. Otherwise it runs the jobs below (a native version named below is
the pin when it was written; [`.github/runtime-versions.json`](../.github/runtime-versions.json)
is authoritative). The `behavior`, `acp-behavior` and
Pi RPC jobs are chosen by [`.github/scripts/ci-select.mjs`](../.github/scripts/ci-select.mjs):
a pull request runs the backends its changed files can reach on Linux, plus
Windows OpenCode v2 (`opencode-v2-aimock`) when OpenCode is reached
(a runtime's own directory or its vendor tests reach that runtime; shared code,
contracts, the behavior harness, CI or anything unrecognized reach all of them;
docs, Markdown, tests other than `tests/fixtures/`, the CLI and apps reach
none; `experiments/` code reaches all, because vendor tests and the behavior
harness import its probes). A push to main and a dispatch run all Linux
backends plus the Windows jobs that caught platform-only product failures in
the 50-run audit (Windows `check-windows` including `opencode-cleanup/skills`,
Windows `dsh-aimock`, Windows `codex-aimock`, and Windows `pi-rpc-windows`
vendor). No macOS jobs run on push or release, so pushes and releases never
wait on the macOS runner queue. Windows `opencode-v2-aimock` stays on PRs that
reach OpenCode and runs daily in `platform-matrix.yml`, parked off main push
and release until its known readiness flake (`#core:#360`) is fixed. All macOS
jobs and the remaining Windows behavior, ACP and native helper matrices run
daily and on demand in
[`.github/workflows/platform-matrix.yml`](../.github/workflows/platform-matrix.yml);
the release gate waits only on `ci.yml` for the exact release commit and does
not wait on `platform-matrix.yml`. A regression that only the daily matrix
finds can therefore already have shipped, and is handled like a bug report. A
newer push or dispatch on the same ref cancels any in-progress or queued
`ci.yml` run it supersedes.

- `check`: `pnpm run check` and `pnpm run build` on Linux.
  The browser-entry unit test bundles the complete portable entry for a
  browser and refuses Node imports or unresolved externals. Synthetic
  sharing routing and public placement-refusal regressions stay in this job.
- `check-native`: runs in parallel with `check` on Linux: `pnpm run build`,
  offline Cursor SDK skill-loader parity against local fixtures, OpenCode 2.2.7
  isolated native tool cleanup and skills, Kimi native login and workspace skill
  discovery cleanup (both `kimi-login` and `kimi-skills` pins), and the pinned
  agy CLI 1.5.11 (`antigravity-aimock` behavior, vendor and file-skills suites
  against a local Gemini provider in an isolated home, concurrency 2). OpenCode,
  Kimi and Antigravity upload diagnostic artifacts, failures included.
  CodeBuddy's fake-npm installer unit tests remain in `check`; its real public
  installer runs daily in `runtime-latest.yml`.
- `check-windows` (shards 1/2 and 2/2): sharded `pnpm vitest run --shard=N/2`
  with `OAR_COMMUNITY_TESTS=1` on `windows-latest`, plus the mock behavior
  suite and OpenCode 2.2.7 isolated native tool cleanup/skills on shard 1.
  Kept on every push/PR because Windows unit tests and `opencode-skills`
  caught Windows-only failures; macOS unit/native checks and Windows
  non-OpenCode native checks run daily in `platform-matrix.yml`.
- `behavior`: `pnpm run sea-trial` plus the backend's vendor tests on Linux for
  all nine backends (`claude-aimock`, `codex-aimock`, `pi-aimock`,
  `pi-rpc-aimock`, `pi-durable-aimock`, `qwen-aimock`, `dsh-aimock` pinned to
  0.2.1-rc.5, `qoder-native` pinned to 1.1.81, and `factory-aimock` pinned to
  1.12.1), plus on main pushes/dispatches Windows `dsh-aimock` and Windows
  `codex-aimock`. `dsh-aimock` and `qoder-native` run at shared-case
  concurrency 2; missing `dsh-aimock` or `factory-aimock` installations fail.
- `pi-rpc-minimum`: Ubuntu behavior and vendor suites with a separately
  installed Pi CLI 1.4.0 selected through `OAR_PI_RPC_COMMAND`. This guards the
  explicit-command floor while OAR keeps its current bundled dependency.
  Any floor increase must update this CI pin and `PI_RPC_MINIMUM_VERSION`
  together in the same pull request.
- `pi-rpc-windows`: Windows Pi RPC vendor phase on main pushes/dispatches (job
  ceiling 20 minutes). It runs four named steps in sequence
  (RPC-specific, native Pi, MCP and remaining shared files) that together
  cover every vendor file exactly once, new files included; each starts
  Vitest separately under `windows-pi-vendor.ps1` and `windows-resources.ps1`
  with a five-minute command ceiling inside a six-minute step ceiling, and an
  ordinary failure does not skip later groups. Windows Pi RPC behavior (zero
  unique failures in the 50-run audit) runs daily in `platform-matrix.yml`.
- `acp-behavior`: runs Kimi, Grok, CodeBuddy and both OpenCode majors on Linux
  on PRs and pushes, plus OpenCode v2 (`opencode-v2-aimock`, using the
  `opencode-cleanup` 2.2.7 pin) on Windows for PRs that reach OpenCode. Windows
  OpenCode v2 (parked off push/release until `#core:#360` is fixed), Windows
  OpenCode v1 and macOS ACP jobs run daily in `platform-matrix.yml`.
  The [runtime manifest](../.github/runtime-versions.json) supplies the pins.
  Each job runs shared behavior and vendor tests against the installed
  program using a local scripted provider, isolated configuration, synthetic
  keys and npm download caches. Shared-case concurrency and Vitest worker
  count are both 2; CodeBuddy serializes
  shared cases in its isolated fixture HOME. OpenCode prepares each behavior
  fixture's database with one serial native open and exit before concurrent
  cases begin; a preparation failure stops the suite without retries (the
  independent [cold-start observation](../experiments/opencode-cold-start.ts)
  retains the native database race). A missing installation fails;
  individual unsupported capabilities remain visible skips. Ceilings are 20 minutes per
  job and 12 per suite step, changing no case assertion or native deadline.
  Logs and traces upload even on failure.
  [Evidence and deferred runtimes](../experiments/acp-ci-2026-10-29.md).
- `browser-demo`: `pnpm durable-demo:smoke` in headless Chromium on Linux.
  The real Pi Durable Harness and native fetch provider run in the browser;
  provider requests go to local scripted responses using a synthetic key.
- `clean-install`: `pnpm run clean-install -- --mode=gate`
  ([`tests/clean-install.ts`](../tests/clean-install.ts)) on Linux. Both
  packages are packed and `npm install`ed into an empty project: without the
  optional peers, the root entry and the `browser`, `capabilities`, `forms`, `observe`,
  `kernel`, `brands`, `testing`, `agents` and `agents/report` entries must
  load and type-check, OAR must probe every built-in runtime, and the line
  that adds cursor must fail the host's compile; with the SDK added, cursor
  loads. With the Pi Durable
  peers added, a pi-durable session opens and its entry bundles for a
  browser. The CLI, installed after the host's SDK is removed again, lists
  cursor's models through the SDK it depends on itself. It needs the npm
  registry. The temporary host's root overrides hold the Pi family and undici
  at the accepted workspace versions, derived from `package.json` and the
  installed lockfile graph. The check refuses a baseline outside OAR's
  published ranges. It preserves the imports, type checks, bundles and
  single-copy assertions; only this temporary host receives overrides.
  The resolved versions are retained in `oar-trial-run/clean-install`.

Native CLI jobs in the ordinary gate and Windows ACP observation install from
[`.github/runtime-versions.json`](../.github/runtime-versions.json), with links
to their acceptance evidence. Distinct keys preserve each test's purpose:
DSH and Pi RPC minimums, Qoder replay, Kimi login/skills, and OpenCode v1/v2
helpers do not automatically follow upstream releases. SDK baselines remain
in the workspace manifests and lockfile. The
[`runtime-version.mjs`](../.github/scripts/runtime-version.mjs) reader fails
on a missing pin, invalid manifest or non-exact version. The manual Grok
cold-start experiment uses it to read its separate historical control,
without running `--version` before the numbered observations. The
[`runtime-install.mjs`](../.github/scripts/runtime-install.mjs) installer
requires HTTPS npm tarballs and SHA-512 integrity, checks the downloaded
artifact's digest, installs in a private prefix and HOME, and requires the native `--version` to equal the selected version
before publishing an executable path. Its npm install has a 600-second
ceiling within the enclosing job's budget. These jobs exercise the explicit
`OAR_*_BIN` path (`OAR_PI_RPC_COMMAND` for the Pi floor), so they do not
establish PATH discovery coverage. Reports retain the manifest hash,
artifact identity, native version and failure stage. Antigravity keeps its
platform-specific SHA-512 pins. Artifact downloads allow three total attempts
for socket resets, timeouts and HTTP 5xx, with a 120-second limit per attempt
and one second between retries. CI output and installation reports retain each
attempt. Other HTTP errors, integrity mismatches and native-version mismatches
fail immediately; discovery and package installation are not retried by this helper.
Manual historical experiments retain their
own controls, separate from upgrade candidates. Pin changes require a reviewed
pull request; top-level CLI pins do not freeze npm transitive ranges, runner
images or OS packages.

Outside ci.yml and its pull-request and release gates:

- [`platform-matrix.yml`](../.github/workflows/platform-matrix.yml) runs daily
  at 03:17 UTC and by manual `workflow_dispatch`. It runs the macOS and Windows
  jobs moved off every-push `ci.yml`, sharded through
  [`.github/scripts/run-ci-shard.mjs`](../.github/scripts/run-ci-shard.mjs) so
  checkout, Node and `pnpm install` run once per shard and macOS stays within
  runner concurrency limits (`macos-check`, `macos-behavior-1`,
  `macos-behavior-2`, `macos-acp`, `windows-native`, `windows-behavior-1`,
  `windows-behavior-2`). `release.yml` does not wait on this workflow, so a
  regression it finds can already have shipped and is handled like a bug report.
- [`runtime-latest.yml`](../.github/workflows/runtime-latest.yml) runs daily
  at 06:17 UTC and by manual dispatch. One discovery job freezes candidate
  versions, URLs, digests, timestamp and accepted-manifest hash. Manifest
  hashes normalize CRLF to LF so Windows checkout preserves the same identity;
  changed pin content still rejects the frozen record. After native version
  verification, `OAR_CI_CANDIDATE_VERSION` supplies helper suites with the
  frozen expected version; ordinary CI retains its accepted expectation. Changed
  candidates run supported native behavior/vendor or helper suites on the
  existing OS matrix with local scripted providers. Minimum and replay keys
  (including DSH and Qoder) are excluded from this daily matrix and still
  need the separate upgrade checks in the version inventory. Pi, Pi Durable,
  Chord and Pi's exact undici move together in a disposable SDK checkout; Cursor is
  separate. Its candidate checkout updates the SDK version constant alongside the
  exact peer, so the ordinary peer-consistency assertion still applies. SDK
  manifests and the newly resolved lockfile are retained.
  Discovery, download, install and native-version failures stay red; a partial
  discovery failure still lets other frozen candidates run. The workflow has
  read-only permissions, leaves no checkout token on disk, and never updates
  accepted pins or opens bump PRs. Native job summaries link exact known candidate
  failures to their tracking issue while keeping every failed step red. The
  Kimi 2.6.2/2.6.3 signatures are tracked in [issue 899](https://github.com/botiverse/oar/issues/899);
  a different version, test or assertion and unrelated failed steps remain
  new or unclassified. The additional test report omits assertion values and
  exception messages. Native and SDK candidate jobs use no shared pnpm cache,
  so they cannot save candidate packages under the gate's cache key.
  A focused bump PR also needs the version-specific probes in
  [`experiments/runtime-versions.ts`](../experiments/runtime-versions.ts),
  maintainer review and ordinary CI. A daily pass alone is not acceptance.
  Two daily checks run even when top-level versions are unchanged: CodeBuddy's
  real public npm installer on all three systems, and
  `pnpm run clean-install -- --mode=published` on Linux, which resolves OAR's
  original published Pi ranges without host overrides. CodeBuddy retains
  install phases and npm debug/timing tails before cleaning its isolated
  HOME; its 180-second install and 240-second child limits are unchanged
  ([details](../experiments/codebuddy-install-diagnostics/README.md)).
  The CodeBuddy and published-host jobs have 15- and 20-minute ceilings.
- [`acp-windows.yml`](../.github/workflows/acp-windows.yml) observes the Kimi
  and Grok ACP backends on Windows after main pushes. Each job reports its
  first attempt and retains logs and traces for daily inspection. Grok's
  launch comparison runs after its tests, so it cannot prewarm them. It retains
  bootstrap read/decode/write/copy/spawn phases for the explicit Node path
  and repeats that path and the OAR-resolved executable in the same HOME
  after either success or failure. The seven launches keep their 15-second
  initialize and five-second cleanup limits; the diagnostic step remains
  three minutes. [Measurement scope](../experiments/grok-startup/README.md).
- [`osv-scanner.yml`](../.github/workflows/osv-scanner.yml) scans
  dependencies daily and reports findings in its job log without failing;
  only a scanner error fails it.
- OpenCode and Grok shared placement is not admitted (explicit `shared` is
  refused), so their shared session behavior suites and native
  shared/isolated controls run only in the manual
  `opencode-sharing-experiment.yml` (with a configured plugin
  child-environment comparison) and `grok-sharing-experiment.yml`
  workflows, against experimental adapters outside the package.

The Antigravity, Grok, Kimi and OpenCode synthetic ACP fixtures retain incremental
provider requests, matcher selections and streamed response chunks under
`acp-provider/` in the existing run artifacts.
They survive a failed assertion or unfinished turn and fixture HOME cleanup;
entries and files have explicit size limits. Headers, URL queries and environment
variables are omitted. This is test evidence only and changes no matcher,
assertion or native timeout ([November 6 failures and boundaries](../experiments/acp-ci-failures/README.md)).

Windows `codex-aimock`, every `qoder-native` and `dsh-aimock` behavior job, and the Windows
OpenCode ACP gates and ACP observations, forward child stderr to the job log with
`OAR_CHILD_STDERR=inherit`, including failures before a session trace exists
(a login's or logout's process is never forwarded: its output may carry secrets).
Artifact upload warns when no trace directory was created; the failed test
or startup step still fails the job. Codex RPC exit errors also retain a
bounded stderr tail without this setting, so use that evidence before
changing a timeout or assertion to address an intermittent startup failure.
After a rejected Windows OpenCode fixture open, the trace records recognized database
operations, SQLite codes and error categories from the native log during that open.
The log is shared by processes using the same data directory, so an entry can come
from a concurrent peer. Messages, paths and SQL stay in the fixture.
Installation readiness and `--version` execution failures retain the native
error, signal, timeout, exit code and stderr tail in their exception too.
On a one-shot command timeout, diagnostics also snapshot whether Node had
observed the root process's `exit` and the output streams' `close`, with the
root's exit time, elapsed duration, code and signal when available. The
snapshot is taken before cleanup; a later cleanup-induced exit cannot replace
it. This distinguishes an exited root with open pipes from an exit not yet
observed without changing deadlines, pipe draining or process cleanup.

The [Windows Codex comparison](../experiments/windows-codex-ci/results.md)
(nine default/two/one file-worker samples, including a cleanup timeout in the
single-worker group) does not establish a worker-limit remedy; CI keeps its
per-case concurrency, assertions and deadlines.

## How to add a new runtime

1. **Probe reality first.** Write an experiment that answers how the vendor
   actually behaves (session lifecycle, event stream, error shapes) and index
   its conclusion in the experiments README. Build the adapter on that
   evidence, not on the vendor's docs, and against the runtime's own
   interface, never another host's adapter for it
   ([decision](design/decisions.md#reaching-a-runtime-through-another-hosts-adapter-2026-10-05)).
2. **Implement it in `packages/oar/src/runtimes/<id>/`.** `index.ts` declares
   the runtime with `defineRuntime({ id, ... })`, listing only the
   capabilities the runtime honestly supports: an absent capability is
   correct, a faked one is not. That `index.ts` is also the public
   `@botiverse/oar/runtimes/<id>` entry, so it imports no SDK statically:
   load SDK-bound code on first call (`onFirstCall`, `shared/lazy.ts`) and
   add the id to `tests/runtime-entries.test.ts`. The session adapter feeds a
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
   - stdin EOF shutdown (`shutdown: "stdin"` on `spawnLineProcess` or
     `closeLineProcess` for idle session disposal) is used only on runtimes
     measured to exit on stdin EOF (active turns still terminate immediately);
     runtimes that stay open after stdin closes (such as CodeBuddy `--acp`)
     must not use it, and shared transports such as `startAcpProcess` must not
     enable it globally;
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
3. **Cover the whole runtime in the first version, not just sessions.**
   Hosts need the account side on day one: installation and version
   (`installation`, `install`/`installPlan`, `checkUpdate`/`upgrade`),
   sign-in (`login`, `logout`, `authStatus`, `providers`), `listModels`,
   `accountUsage`, and limit resets where the runtime has them. For each, find
   the runtime's own interface for it first (a CLI subcommand, a protocol
   method, a read-only slash command) and implement it in the same change.
   Where the runtime has none, leave the member absent or return its typed
   `unsupported` with the reason, and say on the runtime page what was
   checked, so the gap is a finding, not a deferral. A usage or rate limit the
   runtime reports on a turn is classified as a limit from the start
   ([why](design/decisions.md#a-new-runtimes-first-version-2026-11-13)).

   **Per-model facts are checked for every model.** Effort menus and
   default effort, service tiers, `disabled` and any other `ModelEntry`
   value that can differ between models are compared, for each model
   `listModels` returns, with what the runtime itself reports after that
   model is selected. Testing only the default model is not evidence for
   the others: Antigravity's adapter before
   [#834](https://github.com/botiverse/oar/pull/834) read only the current
   model's effort menu, so every other model showed none.
4. **Register it in `src/index.ts`**, the only composition root: import, add
   to the built-in `defaultRuntimes` registry, re-export. Give it a `runtimeBrands`
   entry in `src/brands.ts` with its SVG in `packages/oar/assets/brands/`
   (attribution in `NOTICE.md`). A runtime that needs something the host
   installs (cursor's SDK) is not built in: export its constructor instead,
   and add it to `allRuntimes` in `sea-trial/harness/runtimes.ts` and to the
   CLI's registry in `packages/cli/src/runtimes.ts`
   ([capabilities](design/capabilities.md#a-runtimes-own-settings)).
   A runtime with host-owned execution/storage, such as pi-durable, stays out
   of the default and CLI registries; test it with its configured fixture.
5. **Make the behavior suite pass unchanged.** `OAR_TEST=<id> pnpm sea-trial`
   against your real local installation. The cases in `sea-trial/cases/` are
   the contract: make the runtime pass them, don't loosen them to fit. A case
   that needs a capability skips on its absence (a session without `steer`),
   never on a runtime name.
6. **Add an aimock backend if feasible** (`sea-trial/harness/aimock.ts`,
   `backends.ts`, and the backend lists and runtime map in `.github/scripts/ci-select.mjs`) so
   the contract stays verifiable without a login, and add vendor tests for the
   provider-side specifics worth pinning.
7. **Update the docs in the same commit**: the runtime lists in the root and
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
`packages/oar/package.json` and `packages/cli/package.json`; its body is the
release notes. Squash merge it, then start
[`.github/workflows/release.yml`](../.github/workflows/release.yml) on main:

```bash
stamp workflow run release.yml --repo botiverse/oar -f version=X.Y.Z
```

From the release commit's merge until its tag exists, do not merge a pull
request that changes `.github/workflows/`. A workflow change on main can
make GitHub reject the older commit's new tag as a workflow update, which
the release job's token cannot authorize. Cindy owns this hold and lifts
it once the tag is confirmed at the release commit.

Dispatch right after the release pull request merges: the workflow releases
the head of main only after `ci.yml` succeeded on that exact commit (the
Linux gate, sharded Windows unit check with `opencode-cleanup`, and Windows
`dsh-aimock`, `codex-aimock`, `pi-rpc-windows` vendor; no macOS jobs, and it
does not wait on daily `platform-matrix.yml`, and a docs-only head has no run
and fails the gate). It refuses a version that
already has a tag or differs from either package version, runs
`pnpm run check` and `pnpm run build`, and publishes both packages with
`pnpm -r publish`, which rewrites the CLI's `workspace:*` dependency to the
real version. A separate `release` job, which runs no project code and is
the only one with write access, then creates the annotated `vX.Y.Z` tag and
the GitHub release, whose notes are the release pull request's body. For a
transient failure after publishing, "Re-run failed jobs" retries only the
failed release job. A workflow-permission refusal needs the recovery below;
retrying does not grant the missing permission. If `ci.yml`
flaked on the release commit, start a fresh run with
`stamp workflow run ci.yml --repo botiverse/oar` and dispatch again once it
passes. npm trusted
publishing (OIDC) authenticates the publish job; the repo holds no npm
token. Pushing a `vX.Y.Z` tag by hand still publishes that commit when it is
the matching merged release pull request, without the CI gate or the GitHub
release.

### Recover after npm publication

If tag creation fails with `without workflows permission`, keep the original
run's commit as the release target. This can happen when main gained workflow
changes while the release waited for CI or published, so the release
commit's workflow files differ from main's; containing a workflow change
does not by itself make a release fail
([0.108.1 investigation and recovery](../experiments/release-tag-permission-2026-11-15.md)).

`gh release create --target <sha>` does not avoid the problem: GitHub
documents the same workflow-write requirement, which `GITHUB_TOKEN` cannot
acquire, for [automatic tag creation by the releases API](https://docs.github.com/en/rest/releases/releases#create-a-release),
and lists it for the [create-reference API](https://docs.github.com/en/rest/git/refs#create-a-reference)
too (not a verified bypass). Do not tag a newer main or add a more
privileged credential to the job.

Only Cindy performs this recovery:

1. Save the failed run and its full commit SHA. Confirm the `publish` job
   succeeded and both exact package versions are present on the public npm
   registry (`npm view @botiverse/oar@X.Y.Z version` and
   `npm view @botiverse/oar-cli@X.Y.Z version`, both with
   `--registry=https://registry.npmjs.org`). Verify those names and versions
   against the manifests at the original commit. Missing or inconsistent
   publication evidence needs investigation, not this recovery.
2. Read the remote tag, including the peeled commit for an annotated tag:
   `git ls-remote origin refs/tags/vX.Y.Z 'refs/tags/vX.Y.Z^{}'`.
   If it already points to the original commit, skip tag creation. If it
   points elsewhere, stop; do not move or force-push it.
3. Only if the remote tag is absent, create it at the verified original
   commit and push through Stamp from a checkout configured with
   `stamp repo use .`. Replace the placeholders before running:

   ```bash
   git tag -a vX.Y.Z ORIGINAL_RELEASE_COMMIT_SHA -m vX.Y.Z
   stamp push origin refs/tags/vX.Y.Z
   ```

   An existing local tag must be checked against that commit too; do not
   overwrite it. Check Stamp's publication receipt and re-read the remote
   tag before continuing. Stamp has a different authorization path from
   the workflow's `GITHUB_TOKEN`; if it refuses the push, keep the failure
   and resolve that permission with the repository owner.
4. An external tag push, unlike one made with `GITHUB_TOKEN`, triggers the
   legacy tag-push publish workflow (on 0.108.1 it reran the publish
   command, which found no new packages). Record and inspect that run before
   dispatching recovery. Do not promise that a manual tag push runs only the
   release job, and do not start another normal publish dispatch or rerun
   all jobs after npm publication succeeded.

If npm publication succeeded and the correct tag already exists but the
GitHub release is missing, dispatch the recovery path explicitly from main
(also when recovering an older version; do not use the tag as `--ref`):

```bash
stamp workflow run release.yml --repo botiverse/oar --ref main -f version=X.Y.Z -f release_only=true
```

Recovery does not publish packages, create or move tags, run package code,
or require the historical version to remain npm's `latest`. It requires
both exact package versions on the public npm registry, matching package
names and versions in the tagged commit, and exactly one merged release
pull request for that commit. It takes notes from that pull request rather
than current main, verifies the tag has not moved, and uses
[`gh release create --verify-tag`](https://cli.github.com/manual/gh_release_create).
Missing or inconsistent evidence, API errors and an already existing GitHub
release fail the recovery. Normal publication keeps its existing gates.
