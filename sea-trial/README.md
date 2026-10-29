# sea-trial: the behavior test estate

    main.ts        one backend per process: OAR_TEST selects; absent skips locally,
                   OAR_TEST_REQUIRE_AVAILABLE=1 fails a missing installation
    all.ts         several backends CONCURRENTLY (process = isolation unit)
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
parent process; `windows-resources.ps1` enforces a separate three-minute case
ceiling and ten-minute command ceiling. Existing shorter Vitest timeouts stay
unchanged. An external timeout returns 124 and stops only the launched test
process tree, leaving the CI step able to upload evidence.

`pi-rpc-stderr.ts` observes the real Pi RPC launch in test workers without
changing its inputs or process implementation. It periodically saves the last
8 KiB of stderr with the active case name, applying the session's credential
redactor and inherited credential environment redaction. Native sessions keep
stderr private in production. These files and the combined Vitest output are
under `oar-trial-run/pi-rpc-diagnostics/`, included in the existing `always()`
artifact upload. The bundled-host subprocess is outside this test observer;
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
