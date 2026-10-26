# sea-trial: the behavior test estate

    main.ts        one backend per process: OAR_TEST selects, absent skips
    all.ts         several backends CONCURRENTLY (process = isolation unit)
    cases/         the shared behavior suite: public-API assertions only,
                   must run on EVERY backend (real logins included)
    vendor/        *.vendor.test.ts: vitest, OAR_TEST-gated; anything that
                   needs the scripted provider's view or vendor fingerprints
    vendor/support/ assertion helpers, tool-round script, system-prompt capture,
                   echo MCP server entries and scripted calls
    harness/       backends.ts (OAR_TEST → runtime + optional aimock),
                   aimock.ts (scripted-provider setup per runtime),
                   aimock-acp.ts (the same for the ACP CLIs, used by the
                   mcpServers vendor test: OAR_TEST=<grok|kimi|opencode|
                   antigravity>-aimock),
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
failures. The investigation and remaining uncertainties are recorded in
[Windows CI investigation](../experiments/windows-ci-2026-10-26.md).
