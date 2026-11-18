# Windows shell and Pi child-process observations

PR #953's [Windows job 134931195528](https://github.com/botiverse/oar/actions/runs/44341162528/job/134931195528)
failed three unchanged controls. The hook test's legacy PowerShell expression
returned status `null` instead of the expected 1. The first Pi bash environment
case reached its 30-second test deadline; the second passed in about 14.6 seconds.
The synthetic Pi key-command resolver reported `configured: false` after about
11.3 seconds. All four focused controls passed on Linux.

The original log cannot locate the delay. It omits the legacy PowerShell error
and signal, the Pi tool's stages, and the native key resolver's spawn result.
Pi gives the Windows key-command child 10 seconds and maps most failures to an
absent value, losing the reason. A common child-startup delay is only a hypothesis.
[#955](https://github.com/botiverse/oar/issues/955#issuecomment-6984444658)
tracks the failures alongside the separate process-table observation delays.

## Retained observations

The three test files install a test-owned observer around Node's `spawn`,
`spawnSync` and `execSync`, including the live builtin exports imported by the
native Pi SDK. Calls, arguments, return values and thrown errors pass through
unchanged. Async errors are observed through `errorMonitor`, which does not
consume the child's error event. Bindings and listeners are restored in
`afterEach`, which also retains the capture when an assertion or test deadline
fails. Product code, native dependencies, assertions and deadlines are unchanged.

Reports live in `oar-trial-run/cancellation-timing/child-*.json`, included in the
existing Windows cancellation artifact. Each report contains up to 128 events,
a dropped-event count and the last observation time on one monotonic clock:

- SDK/tool construction, execution or key-resolution stage markers.
- Child start, native spawn/error/close or synchronous result/throw, local child
  correlation ID and elapsed time.
- An allowlisted executable name, status, signal, error code and safe reason.

Arguments, environment, working directories, PIDs, output and original error text
are never retained. Unknown executable names and errors become `other`; exit
failure, missing executable/directory, timeout, permission and resource failures
have distinct safe reasons. `execSync` commands are always labeled `shell-command`.
Missing end events and truncation mean incomplete observation, not zero work or
proof of the cause. SDK import and tool construction share one stage because the
native helper owns both; no child event during that stage does not locate the delay.

## Run

```sh
pnpm exec vitest run tests/child-process-diagnostics.test.ts \
  tests/sharing-hook-command.test.ts tests/providers/pi-env.test.ts \
  tests/providers/provider-local.test.ts
```

The observer controls exercise a real timeout and async spawn failure, preserve
the native error behavior, verify restoration and check redaction. The unchanged
Pi tests exercise the observer through the installed SDK itself. Windows CI is
still needed to capture the original failing paths; Linux success does not
explain the Windows failures. A separately authorized retry retains the original
attempt and is not evidence of a fix.
