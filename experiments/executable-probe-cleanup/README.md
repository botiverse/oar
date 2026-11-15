# Executable probe cleanup after pipe closure

A timed-out one-shot command could leave a descendant alive after the root
closed its output pipes. Issue [#789](https://github.com/botiverse/oar/issues/789)
was reproduced on Linux x64, Node 24.19.0, main
`22c4f69feca053ecf4912ee33a43a280e11e57da` and published OAR 0.106.0.
The fix was based on `176923eb`, after the Windows console change #787.
All commands and account replies in this reproduction are synthetic. No
real account or model was used. This does not claim that native Antigravity
or Claude creates the synthetic stubborn descendant.

## Observation and cause

The parent responds to SIGTERM, while its child ignores SIGTERM and closes
stdout/stderr. Node emits `close` when the parent dies. `runExecutable`
cleared its escalation timer on that event, although the child remained in
the original process group. The child was still alive after the default
10-second grace period. A separate sentinel was unaffected.

The Antigravity credits query rejected at its 500 ms whole-call deadline,
but its synthetic child remained alive more than 11 seconds later. The same
lifecycle reproduced in Claude's help preflight and directly through
`runExecutable`. Keeping the pipes open, keeping the parent alive too, or
letting the parent exit while the child holds the pipes all allowed the old
force-cleanup timer to run.

[Selected process observations](results.json) retain all four direct controls
on the old source, the publication, and the fix. With a 350 ms command timeout,
200 ms grace and an additional 700 ms wait, the closed-pipe case left one
child alive on both old versions. All four controls leave none on the fix.
The published package was downloaded from the npm registry; its tarball
SHA-256 is `edaa0fb9d255a79edd84c7b3f62184802f198da5695d7cede81f32ffcbcb0236`.

## Ownership after the fix

POSIX stop captures root and descendant start identities before signalling.
If the launcher has already exited but its pipes are still open, its existing
group supplies the identities. A root PID already occupied by another process
cannot supply that capture. The grace timer and host-exit cleanup retain these
identities after `close`. Force cleanup reads a fresh process table and signals
only matching processes, their current descendants and identity-backed groups.
It never adopts a new group solely because the old numeric group ID reappears.

Both asynchronous process-table reads have a five-second bound. An unreadable
force snapshot does not authorize signals to remembered descendants; only the
still-live direct child has a fallback signal. This is bounded best-effort
cleanup, not proof that inaccessible or previously unobserved processes ended.
The account query deadline is independent of those reads and the grace period.
Windows continues through `killProcessTree`; this change retains its existing
shutdown path and adds closed-pipe regression cases for Windows CI.

## Reproduce and verify

Run from the repository root:

```sh
pnpm vitest run tests/executable-probe-pipes.test.ts tests/probe-cleanup.test.ts
pnpm vitest run tests/account-query-deadlines.test.ts tests/antigravity/antigravity-account-usage-boundaries.test.ts
pnpm vitest run tests/windows-auxiliary-cleanup.test.ts
```

The real-process fixture is
[`probe-background-child.mjs`](../../tests/fixtures/probe-background-child.mjs).
Its closed-pipe timeout and cancellation tests both failed before the fix and
passed afterward on Linux. They also run on macOS in CI. Existing tests retain
the exited-launcher/open-pipe cases. Synthetic process tables cover PID reuse,
group reuse, detached descendants, children born after capture, observation
failure and host exit after `close`.

The Windows-only tests require an actual Windows runner; a Linux skip is not a
pass. macOS and Windows native results must come from the PR's CI. The existing
public-account deadline tests passed locally without changing their deadlines
or cleanup assertions.
