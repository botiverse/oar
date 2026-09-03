# sea-trial — the behavior test estate

    main.ts        one backend per process: OAR_TEST selects, absent skips
    all.ts         several backends CONCURRENTLY (process = isolation unit)
    cases/         the shared behavior suite — public-API assertions only,
                   must run on EVERY backend (real logins included)
    vendor/        *.vendor.test.ts — vitest, OAR_TEST-gated; anything that
                   needs the scripted provider's view or vendor fingerprints
    vendor/support/ assertion helpers, tool-round script, system-prompt capture
    harness/       backends.ts (OAR_TEST → runtime + optional aimock),
                   aimock.ts (scripted-provider setup per runtime),
                   runner.ts / subject.ts / trace.ts
    fixtures/      the in-process mock runtime (contract-in-one-screenful)

Layer rule (see docs/development.md): the assertion channel decides where a test
lives. Artifacts land under ./oar-trial-run/ per run.
