# Native Qoder evidence

The reusable probe is the native vendor suite and its fixture builder:

```sh
OAR_TEST=qoder-native pnpm vitest run sea-trial/vendor/qoder.vendor.test.ts
OAR_TEST=qoder-native pnpm vitest run sea-trial/vendor/qoder-prompts.vendor.test.ts
OAR_TEST=qoder-native pnpm vitest run sea-trial/vendor/qoder-steer.vendor.test.ts
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
- New replacement and appended system prompts both reach the native model
  input on resume, replacing the previous prompt configuration. The prompt
  regression deliberately exhausts the native replay and reads the request
  retained in its saved error, rather than inferring application from argv.
  Each multiline prompt exceeds the Windows command-line limit and travels
  through a private file. No provider request leaves the native replay.

The two real-account requests failed with code 118, exhausted personal
Credits, and default wire usage zero. `tests/fixtures/qoder-quota.json` retains
their original result frames and exact error text. This does not verify a
successful real-provider turn or prove zero cost. Further real requests were
stopped; they require restored account availability. See the
[runtime mapping](../../docs/runtimes/qoder.md) for the exposed capabilities
and remaining verification boundaries.

### Windows and Linux startup comparisons (2026-10-23)

A cold native initialize completed in 13.7 seconds including launch and a
preliminary version query. Five serial vendor tests passed. The unbounded
shared suite exceeded the existing help (15 seconds) and initialize (30
seconds) deadlines; the same suite passed with `OAR_TEST_CONCURRENCY=2`.
This bounds test-case concurrency, leaving the adapter and all per-operation
deadlines and assertions unchanged. It does not establish which resource
caused the unbounded startup failures. The local native reader used no account.
Another two-case Windows run later timed out in three initialize calls even
after the version-only probe change. This remains unexplained; the current
fixture retains native startup logs under `OAR_TRIAL_RUN_DIR` and CI forwards
stderr to improve the next failure's evidence. See the runtime page for the
original failing run.

```sh
OAR_TEST=qoder-native OAR_TEST_CONCURRENCY=2 pnpm run sea-trial
```

Windows and Linux CI use that concurrency setting. Other backends keep their existing
concurrency. Diagnostic runs: [unbounded](https://github.com/botiverse/oar/actions/runs/40008559577)
and [two concurrent cases](https://github.com/botiverse/oar/actions/runs/40011070963).

Linux also exceeded the help deadline without a concurrency cap. A subsequent
[cold, serial and two-case comparison](https://github.com/botiverse/oar/actions/runs/40014865655)
passed; initialize took 6.979 seconds from the request, 9.957 seconds including
discovery and startup. The runtime page retains both failures and comparisons.

### Installation query comparison (2026-10-23)

`pnpm tsx experiments/qoder-native/installation.ts` compares `--version` and
`--help` in three separate fresh homes each, then repeats each query in its
same home. It sends no prompt or login request. Linux Qoder 1.1.78 returned
its version in 0.490 to 0.909 seconds cold and 0.418 to 0.531 seconds warm;
help took 1.375 to 1.773 seconds cold and 1.455 to 1.545 seconds warm. Both
commands extracted native files, but version avoided the heavier help path.
OAR now uses that single query. The timeout regression retains probe failure
rather than misreporting an installed executable as missing.

### Fixture cleanup (2026-10-24)

Windows CI measured 21 to 43 seconds to remove an initialized isolated HOME
after native exit, versus roughly 12 to 34 milliseconds to copy its logs.
The [runtime evidence](../../docs/runtimes/qoder.md#concurrent-startup-observations)
retains the instrumented run and a later whole-test timeout. Native vendor
cases use `qoderFixture` so this cleanup runs in its own 90-second finished
hook. Cleanup failures still fail the case. The native controls, assertions,
session disposal and original behavior deadlines remain in the test body.

### Input priority (2026-10-24)

```sh
OAR_QODER_BIN=/path/to/qodercli pnpm tsx experiments/qoder-native/priority.ts
```

On Linux Qoder 1.1.78, all eight controls passed. Each combination below runs
once with a successful second scripted response and once with deliberate replay
exhaustion. The exhausted response preserves the actual next model request,
proving it contains the injected marker. Both input IDs reach native terminal
lifecycle states. The report retains only normalized input identities, lifecycle
and result facts, and marker-presence booleans, with no account or local paths.
It is written to `oar-trial-run/qoder-priority/report.json`.

| Injection point | `priority` | Native behavior |
| --- | --- | --- |
| First text delta | `now` | An `aborted_streaming` result and `cancelled` lifecycle end the initial input, then the injected input starts and completes as a new query. |
| First text delta | `next` | The text-only initial query completes normally, then the injected input starts and completes as a new query. |
| Blocked MCP handler | `now` | The initial query reports `aborted_streaming` and is cancelled while the handler remains blocked; the injected input starts a new query. The probe subsequently releases its own handler. |
| Blocked MCP handler | `next` | After tool release, a user echo carries the injected input UUID. The injected lifecycle starts and completes inside the initial query, which emits one successful result. The captured model request includes both the tool result and the injected input. |

`command_lifecycle.command_uuid` preserves both submitted input identities.
The tool-boundary `next` echo also preserves the injected UUID. In the exhausted
controls, native cancellation of the injected lifecycle is the expected result
of the deliberate replay failure, not lost input: its marker is in the saved
model request. Successful controls verify that the same paths can finish.

OAR maps `next` to steering, with the same
possibility of becoming a following turn when the current query has no further
tool boundary. A `now` mapping must preserve the original turn's native abort
and the following input's separate turn, so OAR does not use it for steering.
Two native vendor regressions exercise the OAR `steer` path at both injection
points, asserting echoed input identity, successful completion and exactly one
or two native turn ends respectively. OAR enables `--replay-user-messages` to
retain identity when the input becomes a following turn. The two OAR steering
regressions passed on
[Windows](https://github.com/botiverse/oar/actions/runs/40053017848/job/120749644261)
and [macOS](https://github.com/botiverse/oar/actions/runs/40053017848/job/120749644019)
at `b239c35`, with all eight native cases and the shared suite passing on both
platforms. The raw eight-control `now`/`next` matrix was run only on Linux;
arbitrary external-tool cancellation and process crashes remain untested.
The [initial Windows run](https://github.com/botiverse/oar/actions/runs/40050232565/job/120741056271)
passed the two steering regressions but failed an older effort test at its
whole-test deadline after its recorded turn completed and its process exited
normally. That revision did not measure the remaining cleanup cost. Fixture
cleanup now has its separate bound described above. No paid provider or
existing login was used.
