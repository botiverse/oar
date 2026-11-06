# Windows login fixture: bounded state replacement

November 6, 2026. PR #679's [Windows check](https://github.com/botiverse/oar/actions/runs/42290095183/job/128140953549)
failed before its CodeBuddy install step. The retained fake-login stderr
identifies a state-publication failure, not a native Kimi authentication
failure. [Selected evidence](windows-failure.json) preserves the source log
hash, error code, stack locations and exit result without temporary paths.

`fake-kimi-login.mjs` called `saveLoginState` at its first save, before
reporting login success. `renameSync` could not replace the published JSON:
Windows returned `EPERM`, and the fake exited with code 1. Its confirmation
ACP process never started. The existing assertion still expected both
calls, and failed. The five real Kimi login controls later passed in the
same job; the earlier unit failure skipped CodeBuddy installation, so this
job supplies no install-duration sample.

This is the first retained direct `EPERM` evidence for this failure shape.
Earlier Kimi failures had no process stderr and cannot retrospectively be
assigned this cause. The process holding the file, if any, is unknown.
Windows file sharing can prevent renaming when an existing handle does not
permit delete access, as described by
[Microsoft's CreateFile documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#parameters).
That mechanism is possible here, not an identified handle owner.

## Fixture change

The shared state writer retries only `renameSync` failures with code
`EPERM` on Windows. There are at most ten retries, with 25 ms between them:
250 ms of requested waits in total. Filesystem calls and scheduling can add
wall time. Persistent refusal still throws the last native error; other
errors and other platforms are not retried.

The completed temporary file is reused. The published snapshot remains
unchanged until replacement succeeds; the writer never deletes the old
file or falls back to writing it in place. Killing the fake during a retry
therefore preserves the previous complete JSON. An unpublished temporary
file remains inside the disposable fixture directory.

This helper serves the Claude, Codex, Kimi, Qoder and CodeBuddy login fakes.
No product authentication code, outer test timeout, call-list assertion,
PID requirement or process-liveness assertion changes.

## Reproduce the controlled cases

```sh
CI=1 pnpm vitest run tests/login/login-state-rename.test.ts \
  tests/login/login-fixture-state.test.ts tests/login/kimi-login.test.ts
```

The new preload injects filesystem refusal into a real fake-login child.
It selects the Windows policy on every CI host while keeping the host's
real filesystem calls. The controls verify two transient refusals followed
by publication, persistent refusal reaching the retry bound, immediate
failure for another error or a non-Windows platform, and interruption at a
fixed checkpoint before the retry. Existing empty/partial-write interruption
controls still cover all five fakes.

On Linux, the old helper failed three new controls; the fixed helper passed
all 31 focused cases. This proves the refusal/retry and snapshot behavior
under controlled errors. It does not reproduce the original Windows file
holder or prove that it would release within 250 ms. Windows validation
belongs to this PR's ordinary CI.
