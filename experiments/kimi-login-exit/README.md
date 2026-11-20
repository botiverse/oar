# Kimi login browser exit observation

On Linux with Kimi 2.4.1, the native login can finish successfully and its
browser helper can be gone without the test preload recording the helper's
`exit` callback. The callback runs inside Kimi. Kimi calls `process.exit(0)`
after saving credentials and provisioning the model, so it can terminate that
observer before the callback runs.

The missing callback caused the Windows assertion in
[issue #869](https://github.com/botiverse/oar/issues/869), first in
[job 133855969877](https://github.com/botiverse/oar/actions/runs/44028958607/job/133855969877)
and again on main in
[run 44035678076](https://github.com/botiverse/oar/actions/runs/44035678076).
Those records did not independently check the helper PID. They establish a
missing callback, not whether the historical Windows helper survived. The
Linux control below reproduces a false failure of the old assertion.

## Native control

Run with the official `@moonshot-ai/kimi-code@2.4.1` executable on Linux:

```sh
/absolute/path/to/kimi --version
OAR_TRIAL_RUN_DIR=/tmp/kimi-login-exit \
  pnpm tsx experiments/kimi-login-exit/probe.ts /absolute/path/to/kimi
```

The probe uses the real CLI, a synthetic local OAuth/model server, an isolated
Kimi home and a no-op browser helper. It runs three successful logins with
helper delays of 0, 100 and 1000 milliseconds. It makes no model calls and
uses no real account. Each login keeps the existing 30-second deadline.

[Selected result](result.json), measured on Linux x64 on 2026-11-17:

| Helper delay | Login | Callback recorded | Helper present after login | Native observer present |
|---|---|---|---|---|
| 0 ms | logged_in | yes | no | no |
| 100 ms | logged_in | no | no | no |
| 1000 ms | logged_in | no | no | no |

In all three cases the observer that launched the browser recorded its own
exit code as zero. The launcher and exit records are correlated by observer
PID, so the subsequent authentication subprocess cannot replace that result.
The original probe checked whether each PID was present. The current probe
records the helper and observer start times, then checks both identities after
login. Its own process is the live control. A reused PID counts as an exit,
and failures to read process information propagate. The exact callback timing
is scheduling-dependent and is reported, not used as a success condition.
Raw fixture diagnostics remain under `OAR_TRIAL_RUN_DIR/kimi-login`.

The npm bundle's `src/utils/open-url.ts` calls `execFile` without awaiting the
browser. `src/cli/sub/login-flow.ts` calls `process.exit(0)` after the login
result and `process.exit(1)` on failure. Both are visible in
[`dist/main.mjs` of the pinned package](https://unpkg.com/@moonshot-ai/kimi-code@2.4.1/dist/main.mjs).
The bundle and controlled run explain how the callback can be lost.

## Regression and scope

The [native login test](../../sea-trial/vendor/kimi-login.vendor.test.ts) now
checks the launched helper PID from the surviving test process. It still
requires exactly one browser command, the correct executable for permitted
and suppressed opening, removal of the suppression helper, native credential
and model writes, successful status and logout, and the existing cancellation
and provisioning-failure results. No deadline, retry or polling policy changes.
The fixture retains native observer exits, callback records and independent
process observations in the existing CI artifact.

This is a test observation change. The callback logger exists only in the
[fixture](../../sea-trial/vendor/support/kimi-login.ts). Product
[login](../../packages/oar/src/runtimes/kimi/login.ts) reads the native login
process exit and success marker, then checks authentication.
[Browser suppression cleanup](../../packages/oar/src/runtimes/kimi/login-browser.ts)
removes its temporary helper independently. Neither reads the test callback.
The result makes no general promise about the lifetime of a user's real
browser or unrelated descendants.
