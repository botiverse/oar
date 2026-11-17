# Kimi expired access tokens and native refresh

Measured November 17, 2026 on Linux x64 with Kimi Code 2.4.1 (OAR's minimum)
and 2.6.2 (npm latest when measured). All credentials are synthetic and all
OAuth/usage servers bind loopback. No account login, model prompt, real token
or paid API was used.

## Result and ownership

`kimi web --no-open --host 127.0.0.1 --port 0` exposes
`GET /api/v1/oauth/usage`. Its managed usage service calls the native OAuth
manager's `ensureFresh` before requesting the quota. Kimi performs refresh,
cross-process locking, credential re-reads and file updates. OAR only starts
and queries that native service, projects its quota, and stops the owned
process tree. `GET /api/v1/oauth/userinfo` provides optional profile metadata
through the same refresh owner. ACP `/usage` describes a session's token and
context usage, not this account quota.

The source uses a native file lock on Linux/macOS. Windows and
`KIMI_DISABLE_OAUTH_LOCK=1` deliberately skip it. On those paths OAR keeps
read-only HTTP access for a current token. If the stored access token is
expired but a refresh token exists, OAR sends no quota/profile HTTP request
and returns `{ kind: "unavailable", reason: "access_token_expired" }`.
It requests no login and does not assert that the refresh token is valid.
An expired token without a refresh token is `reauth_required`.

| Observation | Result |
| --- | --- |
| Expired token, native Web, 2.4.1 and 2.6.2 | Native refresh wrote a fresh token and the quota request used it. |
| Two Web processes, native lock, 2.6.2 | One refresh POST; both usage requests used the refreshed credential. |
| Two Web processes, native lock disabled, 2.6.2 | Two refresh POSTs. This demonstrates duplicate rotation attempts, not a real account logout. |
| Refresh rejected, both versions | Native stored its empty-token revocation marker; OAR returns `credentials_rejected`. |
| Refresh transport failure, 2.6.2 | Native retried three times, left the credential unchanged, and reported an operational error. |
| OAR refresh never completes | The caller deadline rejects; owned processes stop and the credential remains unchanged. |
| OAR lock explicitly disabled | Temporary unavailable, no HTTP calls, byte-identical credential. |

Native refresh errors lose the HTTP status on this Web route and retain only
an error message. OAR does not classify that prose. It checks only a missing
credential or Kimi's persisted revocation marker; an unexplained native error
rejects with a sanitized operational failure. A quota response that retains
401/403 still establishes rejection. The native error text and Web banner's
bearer token never become result fields.

The durable vendor fixture adds a stricter control than the initial scratch
probe: its server rejects a second rotation of the same synthetic credential.
Two concurrent public readers must still both succeed with one refresh POST.
It checks child PIDs are gone after success, rejection, network failure and
timeout. Windows branches assert read-only refusal; they do not exercise
native refresh. Local results are Linux evidence; the macOS lock path is
source-confirmed and awaits platform CI.

## Cost and limits

Cold native Web startup took about two seconds in the first 2.6.2 sample,
in addition to OAR's existing provider discovery. It creates native device,
server-token, log, session-index and query-store files in the selected Kimi
home. No conversation or model request is started. It can use the network
for native startup and the selected account endpoints. The caller's single
budget covers provider discovery, startup and HTTP; at expiry normal owned
shutdown continues under the existing process cleanup rules.

An `available` result maps native 5-hour, weekly, monthly-total and
monthly-code ratios and reset timestamps. A native Extra Usage balance with
spending headroom can override exhausted subscription windows; reaching only
that spending cap does not imply the subscription is exhausted. Empty or
malformed quota data is never reported as zero usage. The extra `unavailable`
union branch requires exhaustive host switches to be updated.

## Validation

The minimum 2.4.1 passed all six new native usage cases plus five existing
login/account-selection cases. Version 2.6.2 passed the same six new usage
cases. Both versions passed all four existing native skill-discovery cases
after the Web helper extraction. Minimum-version session behavior passed
15 applicable cases (four capabilities skipped). The local commit gate
passed typecheck, lint, 4,560 unit tests and 18 mock behavior cases.

## Reproduce and evidence

Install either version into an isolated prefix, then run from the repository:

```sh
OAR_TEST=kimi-login OAR_KIMI_LOGIN_COMMAND=/absolute/path/to/kimi \
  OAR_TRIAL_RUN_DIR=/absolute/path/to/results \
  pnpm vitest run sea-trial/vendor/kimi-expired-usage.vendor.test.ts
```

The committed [vendor fixture](../../sea-trial/vendor/support/kimi-expired-usage.ts)
and [tests](../../sea-trial/vendor/kimi-expired-usage.vendor.test.ts) are the
maintained reproducer, with isolated homes and loopback endpoints. The
existing account-selection and skill-discovery tests cover the shared Web
helper and native CLI environment. The minimum-version Kimi login CI job
runs the new fixture on Linux, macOS and Windows.

[Selected raw observations](observations.json) preserve outcome, request
order, timing, credential-state booleans and cleanup. Native request IDs,
local paths, arbitrary error prose and credential contents are omitted.
[Raw fingerprints](raw-manifest.json) identify the retained original files.
The initial native-only scratch probe became the stricter vendor test above.

Source pinned at Kimi Code commit
[6a8493df3e1d](https://github.com/MoonshotAI/kimi-code/tree/6a8493df3e1d796a63f7c7ca0de76c1e690cd943):
[Web OAuth routes](https://github.com/MoonshotAI/kimi-code/blob/6a8493df3e1d796a63f7c7ca0de76c1e690cd943/packages/kap-server/src/routes/oauth.ts),
[managed usage owner](https://github.com/MoonshotAI/kimi-code/blob/6a8493df3e1d796a63f7c7ca0de76c1e690cd943/packages/oauth/src/toolkit.ts),
[locking and refresh](https://github.com/MoonshotAI/kimi-code/blob/6a8493df3e1d796a63f7c7ca0de76c1e690cd943/packages/oauth/src/oauth-manager.ts),
[revocation marker](https://github.com/MoonshotAI/kimi-code/blob/6a8493df3e1d796a63f7c7ca0de76c1e690cd943/packages/oauth/src/token-state.ts).
