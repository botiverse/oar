# sea-trial: the behavior test estate

    main.ts        one backend per process: OAR_TEST selects; absent skips locally,
                   OAR_TEST_REQUIRE_AVAILABLE=1 fails a missing installation
    all.ts         several backends with bounded concurrency (each in a process)
    cases/         the shared behavior suite: public-API assertions only,
                   must run on EVERY backend (real logins included)
    vendor/        *.vendor.test.ts: vitest, OAR_TEST-gated; anything that
                   needs the scripted provider's view or vendor fingerprints
    vendor/support/ assertion helpers, tool-round script, system-prompt capture,
                   echo MCP server entries and scripted calls
    harness/       backends.ts (OAR_TEST → runtime + optional aimock),
                   aimock.ts (scripted-provider setup per runtime),
                   aimock-acp.ts (the same for the ACP CLIs),
                   acp-backends.ts (shared CI and daily-probe composition),
                   runner.ts / subject.ts / trace.ts
    fixtures/      the in-process mock runtime (contract-in-one-screenful)

Layer rule (see docs/development.md): the assertion channel decides where a test
lives. Artifacts land under ./oar-trial-run/ per run.

Pi Durable uses `OAR_TEST=pi-durable-aimock`: a real native Harness with host
Models, memory or JSONL storage, and a scripted localhost provider. The
vendor tests cover durable controls, reopen, adoption and watcher overflow.

## Windows Pi RPC resource evidence

CI wraps the Windows Pi RPC behavior and vendor commands with
[`windows-resources.ps1`](windows-resources.ps1). It preserves native exit
codes and output while flushing memory and process identity samples to
`oar-trial-run/windows-resources/`. No command lines or environment values are
collected. Sampling failures are recorded separately; they do not mask test
failures. The vendor job also enables `OAR_PI_RPC_DIAGNOSTICS` in its isolated aimock
fixtures. `pi-rpc-progress.ts` persists case names and results from Vitest's
parent process. The vendor job uses [`windows-pi-vendor.ps1`](windows-pi-vendor.ps1)
to partition every vendor file into four sequential steps: RPC-specific,
native Pi, MCP and remaining shared files. Each group uses a separate Vitest
process with the existing worker settings. An ordinary failed group does not
skip the rest. `-ListOnly` prints a group's files without running it.
`windows-resources.ps1` retains the three-minute case ceiling and gives each
group a five-minute command ceiling, inside a six-minute CI step and the
existing 20-minute job. Existing shorter Vitest timeouts stay unchanged.
An external timeout returns 124 and attempts to stop only the launched test
process tree. Artifact upload still depends on the runner being available.

`pi-rpc-stderr.ts` observes the real Pi RPC launch in test workers without
changing its inputs or process implementation. It periodically saves the last
8 KiB of stderr with the active case name, applying the session's credential
redactor and inherited credential environment redaction. Native sessions keep
stderr private in production. These files and the combined Vitest output are
under `oar-trial-run/pi-rpc-diagnostics/<group>/`, included in the existing
`always()` artifact upload. Resource files use `vendor-<group>.jsonl`.
The jobs API retains each named step's status and timestamps even when the
log API returns 404. That locates the last group the runner reported, without
proving which test or infrastructure component failed.
The bundled-host subprocess is outside this test observer;
its reported errors remain in the combined test output.

The investigation and remaining uncertainties are recorded in
[Windows CI investigation](../experiments/windows-ci-2026-10-26.md).

## ACP jobs

`OAR_TEST=grok-aimock`, `kimi-aimock` and `opencode-aimock` select the
same native sessions and local model fixtures used by the daily probe.
Run `pnpm sea-trial`, then `pnpm vitest run sea-trial/vendor` with that
selection. CI installs exact versions on Linux, macOS and Windows and sets
`OAR_TEST_REQUIRE_AVAILABLE=1`; it does not silently skip an absent binary.
The CI jobs use two concurrent shared cases and two Vitest workers.
For each OpenCode behavior fixture, `beforeSuite` first opens and disposes
one independent native session against its fresh data directory. It waits for
both initialization and exit before concurrent cases begin; a failure stops
the suite with the original error and a preparation trace, without retrying.
The standalone ACP behavior probe uses the same preparation. Vendor fixtures
and native sharing evidence are unchanged. The separate
[`opencode-cold-start.ts`](../experiments/opencode-cold-start.ts) observation
keeps concurrent cold starts visible, including failed native starts, without
mixing them into prepared behavior results. Product deadlines, case deadlines
and concurrency remain unchanged.
Shared-suite output counts passing, skipped and failing cases separately
and names the capability behind each skip. These subjects intentionally do
not expose account usage or standalone model catalogs; Kimi also lacks steer.
Vendor tests for other backends are collected but skipped by `OAR_TEST`.

OpenCode CI uses v1: existing vendor assertions depend on its direct MCP
and prompt protocol. OpenCode v2 and Antigravity remain local probes; see
[platform evidence, timings and feasibility](../experiments/acp-ci-2026-10-29.md).

CodeBuddy uses `OAR_TEST=codebuddy-aimock` with the same public behavior suite,
its own fresh-HOME local-provider fixture, and native ACP vendor tests. It
runs in Linux/macOS pull-request CI; Windows support is not yet verified.
The backend exposes its native model catalog and serializes shared cases.
Title-generation requests receive a separate fixture, so they cannot consume
conversation replies or be counted as duplicated turns.

`OAR_TEST=opencode-shared` runs the session behavior suite through the real
experimental OpenCode 2.2.5 adapter with a local provider; public production
admission remains closed. Each fresh session
gets a distinct temporary project; resume keeps the observed original cwd.
Fresh sessions must report shared placement, while directory reuse follows
the adapter's isolated fallback. The manual experiment workflow can run it on three platforms,
then `sea-trial/vendor/opencode-sharing.vendor.test.ts` checks shared and
isolated lifecycle controls. The fixture PATH excludes relative entries;
custom startup inputs retain their separately tested isolation policy.

`opencode-sharing-experiment.yml` manually runs these candidate controls and
the configured-plugin child environment comparison. They are outside default
`check`; the public isolated cleanup regression remains in ordinary CI.

`OAR_TEST=grok-shared` runs real Grok 1.0.70 with all behavior roots in
one project directory. Fresh roots must actually share. The three `check`
jobs also run `grok-sharing.vendor.test.ts` in shared and isolated placement,
checking models, same-directory MCP, child arrival/association timing, live
terminal trees for both roots, directory reuse and final-lease shutdown.
Artifacts go under `oar-trial-run/grok-sharing`.
