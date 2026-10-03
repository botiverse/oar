# Account usage

`runtime.accountUsage(installation, options?)` reads account quota independently
of session token usage. The [TypeScript contract](../../packages/oar/src/contracts/account-usage.ts)
defines the snapshot and reader options.
A custom runtime's reader (`defineRuntime` with `accountUsage`) builds each
`resetsAt` with `utcInstantFromDate(date)`, which returns null for an invalid
date, rather than casting a string to `UtcInstant`.

## Windows

Each window carries a display `label`, `usedRatio` (0 to 1), and, where the
runtime gives them, `resetsAt`, `id` and `durationMs`. `id` is the runtime's
own key for the window and stays the same across reads, so a host storing
readings over time keys them by `id`, never by `label` (labels are reworded).
`durationMs` is the window's length; with `resetsAt` it places the window's
start, which an even-burn line needs. Sources:

| Runtime | `id` | `durationMs` |
| --- | --- | --- |
| claude | the native key (`five_hour`, `seven_day`, `seven_day_oauth_apps`, `seven_day_opus`, `seven_day_sonnet`, `extra_usage`), and `model_scoped:<display name>` for a model-scoped week (claude names it only by display name) | 5 h for `five_hour`, 7 days for the weekly keys (claude's own `limits[].group` says session or weekly); none for extra usage |
| codex | `<limitId>:primary` or `<limitId>:secondary` | `windowDurationMins` as reported |
| grok, kimi | none | none |

## Failure reasons

Unsuccessful account-usage snapshots retain `kind: "unsupported"` or
`kind: "reauth_required"` and include a stable `reason` from built-in readers.
Consumers should use `reason` rather than infer a cause from the runtime name.
The field is optional for compatibility with older/custom adapters; absent
reasons must be presented as unknown rather than guessed.

| Kind | Reason | Meaning |
| --- | --- | --- |
| unsupported | capability_unavailable | The runtime has no account-usage reader (reported by the CLI/embedding app). |
| unsupported | unsupported_installation | This reader cannot query this installation type. |
| unsupported | unsupported_auth_mode | The selected authentication mode is not supported by the usage reader. This is the adapter's decision, not proof that a token was rejected. |
| unsupported | unsupported_auth_storage | The configured credential storage is not supported. |
| unsupported | auth_configuration_unavailable | The reader could not resolve the provider/auth configuration; no more specific cause is known. |
| unsupported | endpoint_unavailable | The provider/runtime does not expose the queried usage endpoint. |
| unsupported | quota_unavailable | The response does not expose a quota configuration. |
| reauth_required | not_authenticated | The runtime requires a login. |
| reauth_required | credentials_missing | No usable persisted credential was found. |
| reauth_required | scope_missing | The credential lacks the scope needed for usage queries. |
| reauth_required | credentials_rejected | The usage endpoint rejected the credential (401/403). |

Operational failures (network errors, timeouts, malformed responses) still reject
the promise. Reasons do not include tokens, credential values, or raw provider
responses.

Claude account usage delegates to its native stream-json `get_usage` request
(with `skip_behaviors: true`). OAR does not read Claude credentials or call its
HTTP quota endpoint. A native `rate_limits_available: false` becomes
`quota_unavailable`; it does not prove invalid credentials. Older CLIs that
reject the control request return `endpoint_unavailable`. Query-process session
totals are not returned as account usage.
