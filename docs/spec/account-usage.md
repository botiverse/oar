# Account usage

`runtime.accountUsage(installation, options?)` reads account quota independently
of session token usage. The [TypeScript contract](../../packages/oar/src/contracts/account-usage.ts)
defines the snapshot and reader options.

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
