# Native Qoder evidence

The reusable probe is the native vendor suite and its fixture builder:

```sh
OAR_TEST=qoder-native pnpm vitest run sea-trial/vendor/qoder.vendor.test.ts
OAR_TEST=qoder-native pnpm sea-trial
pnpm vitest run tests/qoder tests/login/qoder-login.test.ts
```

Install Qoder 1.1.78, or set `OAR_QODER_BIN` to the selected executable. The
fixture creates a temporary home and project, sets native
`security.auth.useExternal`, and supplies `--fake-responses`. Only the model
provider is replaced; the native session loop, files, controls and MCP clients
run normally. No existing login or paid model request is used.

Observed on Linux on October 23, 2026:

- Consecutive prompts and a new-process resume preserve the native session id.
  A nonexistent resume id refuses opening.
- `result.usage` reports each query. Native
  `QODER_EXPOSE_TOKEN_USAGE=1` exposes 100/10 followed by 200/20; without this
  switch the same provider replies become zero counts. The fixture
  `tests/fixtures/qoder-native-turns.json` preserves the exposed native frames.
- Startup init is idle. Bare partial deltas and the final assistant must not
  duplicate text. The original projection failures are pinned by fixture tests.
- An immediate interrupt can cancel the input before it starts. Native
  cancelled lifecycle is the terminal evidence; there is no result. The
  original shared behavior call waited without input identity and therefore
  never settled. The case now passes that identity to the existing wait API;
  its outcome and late-abort assertions remain intact. The native sequence is
  retained in `tests/fixtures/qoder-cancelled-input.json`.
- Applied `high` effort is read back from `get_settings`, with other private
  configuration redacted. Both stdio and HTTP MCP calls reach the actual local
  servers and return their results. A forced excluded Bash call fails without
  creating its marker file.
- Native `status --output json` explicitly reports login state. A separate
  read-only catalog query returned 15 model entries; no prompt was sent.

The two real-account requests failed with code 118, exhausted personal
Credits, and default wire usage zero. `tests/fixtures/qoder-quota.json` retains
their original result frames and exact error text. This does not verify a
successful real-provider turn or prove zero cost. Further real requests were
stopped; they require restored account availability. See the
[runtime mapping](../../docs/runtimes/qoder.md) for the exposed capabilities
and remaining verification boundaries.

### Windows startup comparison (2026-10-23)

A cold native initialize completed in 13.7 seconds including launch and a
preliminary version query. Five serial vendor tests passed. The unbounded
shared suite exceeded the existing help (15 seconds) and initialize (30
seconds) deadlines; the same suite passed with `OAR_TEST_CONCURRENCY=2`.
This bounds test-case concurrency, leaving the adapter and all per-operation
deadlines and assertions unchanged. It does not establish which resource
caused the unbounded startup failures. The local native reader used no account.

```sh
OAR_TEST=qoder-native OAR_TEST_CONCURRENCY=2 pnpm run sea-trial
```

Windows CI uses that concurrency setting. Other backends keep their existing
concurrency. Diagnostic runs: [unbounded](https://github.com/botiverse/oar/actions/runs/40008559577)
and [two concurrent cases](https://github.com/botiverse/oar/actions/runs/40011070963).
