# Account query deadlines

Issue [#702](https://github.com/botiverse/oar/issues/702), investigated on
2026-11-08, Linux x64, Node 24.19.0. The caller can now receive a deadline
result while OAR finishes the subprocess's existing shutdown. This lets a
host bound account polling without changing process ownership or shortening
the SIGTERM grace period.

## Reproduction and native result

The issue's wrapper forwards the real Codex initialization and account-mode
read, withholds the selected final account request, and SIGSTOPs the native
process. SIGTERM consequently cannot complete shutdown; OAR must escalate
after its default 10-second grace. Each call uses a new empty file-based
credential home and localhost-only network endpoints. In the redemption
case, `account/rateLimitResetCredit/consume` is never forwarded, so the probe
cannot consume a reset.

Base: `2e235c857e07c22d746fcdd0880f6e9b06b44b88`. Each configured deadline
was 800 ms. The wrapper and native process had both exited when cleanup was
recorded; no emergency kills were needed in these passing observations.

| Codex | Call | Base rejection | Patched rejection | Patched cleanup complete |
|---|---|---:|---:|---:|
| 0.131.0 | accountUsage | 10,897 ms | 803 ms | 10,919 ms |
| 0.131.0 | redeemLimitReset | 10,876 ms | 802 ms | 10,891 ms |
| 0.167.0 | accountUsage | 10,871 ms | 802 ms | 10,971 ms |
| 0.167.0 | redeemLimitReset | 10,869 ms | 802 ms | 10,877 ms |

[Selected results](results.json) preserve the signal and cleanup times as
well as the call's settlement time. These are single controlled samples, not
latency percentiles or evidence about Windows/macOS. The issue's original
unanswered initialization incident remains unexplained; forcing a request
to stall isolates the deadline defect without assigning that incident a cause.

Rerun the committed [probe](probe.ts) with an isolated native installation:

```sh
pnpm tsx experiments/account-deadlines/probe.ts /absolute/path/to/codex
```

The [wrapper](wrapper.mjs) uses Linux `/proc` and SIGSTOP. The probe observes
all owned PIDs until they exit, separately from the call's deadline, and
fails if they outlive the cleanup observation window. Normal shutdown and
its default grace are unchanged. The probe does not run in CI or use a
model, existing account or real quota.

## Implementation and public behavior

The shared `withQueryDeadline` boundary settles an answer and aborts the
query at the same deadline. The work still owns its normal `finally` and
process lifecycle; its eventual rejection remains observed. Existing
process tracking, SIGTERM, escalation and descendant cleanup remain in use.
`runExecutable` itself is unchanged and still joins shutdown.

- Codex account usage and reset redemption reject at the deadline. Redemption
  retains the warning that consumption is unknown and retries must reuse the
  same idempotency key. A late account-mode reply or legacy-parameter error
  cannot start a new account request after the deadline.
- Claude account usage shares the deadline across the help preflight, native
  control requests and cleanup. Grok shares it across initialization,
  authentication and billing. Once billing arrives, optional identity ends
  100 ms before the original deadline (or is skipped when that margin is
  reached). An identity failure or timeout returns billing without email,
  while owned shutdown continues in the background. Kimi's
  provider-list preflight no longer waits for shutdown past the usage budget.
- Public `authStatus` for Claude, Codex, Qoder, CodeBuddy, Kimi, Cursor and
  Qwen returns `unknown` with a timeout detail at its deadline. It does not
  turn a timeout into rejection or a logged-out claim. Cursor's SDK loading
  is included; Qwen's file inspection remains local and abortable.
- Login and logout continue to use their internal status readers with joined
  cleanup. Their result semantics and cancellation guarantees are unchanged.
  Qwen provider settings retain their separately documented cleanup behavior.

The owner is the shared execution boundary, with each runtime retaining
ownership of its protocol and result mapping. No public method, option,
result variant or background-cleanup service was added.

## Regression evidence

The real-process [regression](../../tests/account-query-deadlines.test.ts)
exercises each affected executable entry point. It checks return timing,
that the requested protocol stage actually ran, and eventual disappearance
of both root and child. On POSIX the root ignores SIGTERM and must still be
alive when the call settles; on Windows the same test uses native tree
termination without claiming SIGTERM resistance. A control keeps the
internal Codex status reader waiting for cleanup, as required by logout.

Additional controlled tests cover late Codex answers and legacy fallback,
late Claude help, late Grok initialization, Cursor SDK loading and stalled
Qwen file metadata. Existing login/logout and account result regressions
remain part of validation. Cross-platform results are supplied by PR CI;
only Linux was run locally.

Local validation passed: 3,783 tests and 18 mock behavior cases in the full
check, all 15 behavior backends, five native Kimi 2.4.1 login/status/logout
and account-environment cases, both package builds and packed-consumer
validation. The polished native probe was rerun on Codex 0.167.0: 803/802 ms
to reject, 10,892/11,045 ms to finish cleanup, with no remaining processes.

As a regression control, replacing the shared race with an awaited query
while keeping abort and observing the deadline promise makes all four
targeted real-process cases fail: Codex usage, Claude usage, Grok billing
and Kimi provider list take about 3.0 to 3.1 seconds with a 1.5-second deadline
and 1.5-second grace. The production boundary was restored afterward.

Review caught a regression in the first revision: its outer deadline discarded
billing when optional identity stalled. Restoring the existing 1,500 ms
per-request clock advancement and requiring billing from the real-process
identity case both failed on that revision. The correction preserves billing,
uses the earlier identity cutoff, and checks late identity replies and billing
arriving with too little time left to attempt identity. The real-process
regression now allows 4 seconds for startup while retaining its
`< timeoutMs + 1000` result bound and final root/child cleanup assertions.
The mutation timing above was measured before that fixture budget increase.
The full check and package builds passed again after this correction, as did
17 Grok 1.0.70 behavior cases against the local scripted model (two unsupported
capabilities skipped). No live Grok account was queried.
