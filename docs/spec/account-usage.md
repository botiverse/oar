# Account usage

`runtime.accountUsage(installation, options?)` reads account quota independently
of session token usage. It is an optional member: claude, codex, grok and
kimi have it; pi, cursor, antigravity and opencode do not. The [TypeScript contract](../../packages/oar/src/contracts/account-usage.ts)
defines the snapshot and reader options.
A custom runtime's reader (`defineRuntime` with `accountUsage`) builds each
`resetsAt` with `utcInstantFromDate(date)`, which returns null for an invalid
date, rather than casting a string to `UtcInstant`.

## Environment

`options.env` uses the [reader environment contract](orientation.md#environment).
Claude, Codex and Grok run their native usage queries in that environment.
Kimi runs its provider CLI with the overlay and resolves credential paths,
including `KIMI_CODE_HOME` and its home-directory fallback, from the same map.
Its HTTP requests still execute in the host process. It refuses actual changes
(setting or deletion) to `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`
(including their lowercase forms), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`SSL_CERT_DIR` and `NODE_TLS_REJECT_UNAUTHORIZED` before starting the CLI or HTTP.
Equal values and deleting an absent variable are not changes. The rejection is
`UnsupportedOptionError("env")` and names only the affected variables, never
values. Other environment changes remain supported. `orient` records this as
`unsupported`; explicit per-call proxy/CA handling is not provided.

A snapshot belongs to the account resolved by this read. It is not a quota limit
for every account on that runtime. A multi-account host retains its selected
account/configuration key and scopes scheduling decisions to that key plus the
runtime ID. Native email and display name fields can help identify the result,
but are optional and are not guaranteed unique keys.

The CLI also inherits its process environment: `KIMI_CODE_HOME=/home/b oar usage
kimi` selects that home without an extra CLI flag. Use the same environment for
`oar orient kimi --depth account` and the associated agent session. See the
[CLI examples, including PowerShell](orientation.md#cli-and-verification).

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

## Limit resets

Some subscriptions grant resets an account can spend to restore its usage
limits early. Codex reports them in the same read, and an available
snapshot carries them as `limitResets`: `available`, the runtime's count,
and `resets`, its detail rows (`id`, `status`, `grantedAt`, `expiresAt`,
`title`, `description`, each only as reported). Codex may cap the rows below
the count. `resets` is omitted when Codex gave only the count and empty when
it found none; `limitResets` is omitted when the runtime reports nothing.
Only resets of codex's own limits are listed: a row of a kind Codex cannot
name is left out, since OAR cannot say what it would reset.

`runtime.redeemLimitReset(installation, options)` spends one through the
runtime's own call (codex `account/rateLimitResetCredit/consume`, the call
its TUI makes). It is an optional member: only codex has it. It uses up a
reset that belongs to the account owner, so OAR never calls it on its own,
and its MCP server offers no tool for it: a host calls it on the owner's
explicit request.

- `idempotencyKey` is required and names one attempt. Make a fresh unique
  value (a UUID) when the person asks, and send the same value again when
  retrying that attempt. OAR does not make one, because a retry needs the
  first one.
- `resetId` picks a reset from `resets`; omitted, the runtime chooses.
- The result is Codex's own outcome: `reset`, `nothing_to_reset` (no limit
  needed it; nothing spent), `no_reset` (the account holds none, or not the
  one named) or `already_redeemed` (this key's attempt already went through,
  as when a retry follows a call whose answer was lost). An API-key account
  is `unsupported` / `unsupported_auth_mode`, and no login is
  `reauth_required` / `not_authenticated`, as for the read. A Codex without
  the call is `unsupported` / `endpoint_unavailable`.
- A rejection (the deadline, default 20 s; Codex's own 10 s bound on its
  backend; a network error; an outcome OAR does not know) leaves unknown
  whether a reset was spent. Retry with the same key.

No outcome says what the limits are now. Read `accountUsage` again after
any of them; do not infer recovered windows from the outcome. The reset
applies to the account the call resolves, as for the read, so pass the same
`env` as the session and the read.

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
the promise. `options.timeoutMs` bounds the whole read, every process and
request in it included. Reasons do not include tokens, credential values, or raw provider
responses.

Kimi rejects an unreadable response body, invalid JSON, or a response with no
usable quota windows. A window with a malformed present usage metric is omitted;
other valid windows remain. A missing native `used` metric retains its zero
meaning, while an invalid value never becomes zero. Malformed Extra Usage data
does not supply a window or override exhausted subscription limits. Only an
absent credential file is `credentials_missing`; file I/O failures and malformed
credential contents reject with a safe reason, without token bytes or file paths.

Grok can return a valid billing configuration and subscription tier without
`creditUsagePercent` or legacy `used`/`monthlyLimit` metrics (observed with
Grok 1.0.46 on an unused account). OAR follows Grok's native `/usage`
[projection](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/effects/helpers.rs#L1582-L1596)
and defaults these omitted metrics to zero, preserving the plan and reset time.
An absent config still returns `quota_unavailable`; present but malformed
usage metrics still reject.

Claude account usage delegates to its native stream-json `get_usage` request
(with `skip_behaviors: true`). OAR does not read Claude credentials or call its
HTTP quota endpoint. A native `rate_limits_available: false` becomes
`quota_unavailable`; it does not prove invalid credentials. Older CLIs that
reject the control request return `endpoint_unavailable`. Query-process session
totals are not returned as account usage.
