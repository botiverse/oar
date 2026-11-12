# Account usage

`runtime.accountUsage(installation, options?)` reads account quota independently
of session token usage. It is an optional member: claude, codex, grok and
kimi have it; the other built-in runtimes do not. The
[TypeScript contract](../../packages/oar/src/contracts/account-usage.ts)
defines the snapshot and reader options. A custom runtime's reader (`defineRuntime` with `accountUsage`) builds each
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

The CLI inherits its process environment, so `KIMI_CODE_HOME=/home/b oar usage
kimi` selects that home without a CLI flag. Use the same environment for
`oar orient kimi --depth account` and the agent session
([CLI examples, including PowerShell](orientation.md#cli-and-verification)).

A snapshot belongs to the account resolved by this read. It is not a quota limit
for every account on that runtime. A multi-account host retains its selected
account/configuration key and scopes scheduling decisions to that key plus the
runtime ID. Native email and display name fields can help identify the result,
but are optional and are not guaranteed unique keys.

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

`scope` says what the runtime ties a window to: `{ kind: "account" }` when
it reports the window as the account's, `{ kind: "model", name }` when it
reports it as one model's, with the runtime's own name for the model; it
is omitted when the runtime says neither. No runtime names a model id here,
so a host matches `name` to its own models (for example `listModels`
display names); OAR does not guess. A model is held back by every
`account` window and by the `model` windows whose name is that model's;
treat a window without `scope` as `account`.

| Runtime | `account` | `model` (name) | no `scope` |
| --- | --- | --- | --- |
| claude | `five_hour`, `seven_day`, extra usage | `seven_day_opus` ("Opus"), `seven_day_sonnet` ("Sonnet"), each `model_scoped` row (its display name, such as "Fable") | `seven_day_oauth_apps` (third-party apps' use) |
| codex | the unnamed `codex` bucket | a bucket with a `limitName` (such as "GPT-5.3-Codex-Spark") | any other unnamed bucket |
| grok | included usage, pay-as-you-go | none | none |
| kimi | timed windows, Extra Usage | none | a row with only a name |

## Limit resets

Some subscriptions grant resets an account can spend to restore its usage
limits early. Codex reports them in the same read, and an available
snapshot carries them as `limitResets`: `available`, the runtime's count,
and `resets`, its detail rows (`id`, `status`, `grantedAt`, `expiresAt`,
`title`, `description`, each only as reported). Codex may cap the rows below
the count. `resets` is omitted when Codex gave only the count and empty when
it found none; `limitResets` is omitted when the runtime reports nothing.
Only resets of codex's own limits are listed: a row of a kind Codex cannot
name is left out, since OAR cannot say what it would reset. A host that
polls and needs only the count passes `limitResetDetails: false`: Codex then
skips its detail lookup, still reports the count, and `resets` is omitted.
A Codex too old for that parameter (0.131.0 refuses any) is read without it.

`runtime.redeemLimitReset(installation, options)` spends one through the
runtime's own call (codex `account/rateLimitResetCredit/consume`, the call
its TUI makes; claude, see [below](#claude-limit-resets)). It is an
optional member: codex and claude have it. It uses up a reset that belongs
to the account owner, so OAR never calls it on its own, and its MCP server
offers no tool for it: a host calls it on the owner's explicit request.

- `idempotencyKey` is required and names one attempt. Make a fresh unique
  value (a UUID) when the person asks, and send the same value again when
  retrying that attempt. OAR does not make one, because a retry needs the
  first one.
- `resetId` picks a reset from `resets`; omitted, codex chooses. Claude
  requires a kind (`unsupported` / `reset_id_required` without one).
- The result is Codex's own outcome: `reset`, `nothing_to_reset` (no limit
  needed it; nothing spent), `no_reset` (the account holds none, or not the
  one named) or `already_redeemed` (this key's attempt already went through,
  as when a retry follows a call whose answer was lost). An API-key account
  is `unsupported` / `unsupported_auth_mode`, and no login is
  `reauth_required` / `not_authenticated`, as for the read. A Codex without
  the call is `unsupported` / `endpoint_unavailable`, and a non-executable
  installation is `unsupported` / `unsupported_installation`.
- A rejection (the deadline, default 20 s; Codex's own 10 s bound on its
  backend; a network error; an outcome OAR does not know) leaves unknown
  whether a reset was spent. Retry with the same key.

Claude adds three outcomes: `not_attempted` (nothing that could spend was
sent; try again), `unknown` (the command was submitted, or Yes was sent,
and no recognised screen followed; OAR does not retry it) and `unsupported` / `consent_required`.

No outcome says what the limits are now. Read `accountUsage` again after
any of them; do not infer recovered windows from the outcome. The reset
applies to the account the call resolves, as for the read, so pass the same
`env` as the session and the read.

## Claude limit resets

Claude Code offers its resets only through the hidden `/limit-reset` command
of its interactive UI: not in `-p`, the SDK or the control protocol, whose
`get_usage` reads usage without them (2.1.322). OAR therefore starts the
installation's `claude` in a pseudo-terminal (the system `script`, on
Linux only), in a new empty
directory and the call's `env`, types the command, reads the screen, and
ends the process. Why OAR does this at all:
[decisions](../design/decisions.md#claude-limit-resets-through-its-interactive-ui).
One UI runs at a time per process; a call that finds two waiting is
`not_attempted` / `busy`, and one still waiting when its `timeoutMs`
(default 75 s) runs out, or whose turn comes with too little of it left, is
`not_attempted` / `deadline` and never starts. macOS and Windows are
`unsupported_platform`: macOS's BSD `script` exits at once when its stdin
is a socket, which is what Node's pipes are there (macOS 27.0, #752).

Ending a call ends its processes: the shell under `script` runs the program
and, when it exits, ends its whole session; at the end OAR signals what it
finds below `script` while that runs, what it saw there earlier that is
still the same process, and the program's process group while a process
seen earlier is still in it; and it ends every process still carrying the
environment marker the UI was started with (as for Cursor's child). A
process that both left the session and cleared its environment is not
found.

What keeps it from spending a reset the person did not ask for:

- The command always names a kind: `five_hour`, `weekly`, `fable` or
  `full`, typed as `/limit-reset 5-hour` and so on. A bare `/limit-reset`
  can claim with no confirmation, so it is never typed.
- Every screen must match text recorded from Claude Code 2.1.322 word for
  word: the prompt under a `Claude Code v<version>` banner, the
  confirmation dialog for the kind asked (title, the effect line, the
  count line, an optional early-use warning, the selected Yes row naming
  it, No below; only the dates, the count, the percentage and which of the
  known limits the effect line lists may vary, and the list must include
  the kind's own limit), the result lines. There is no version list: a Claude Code
  that draws the same screens works, and one that changed them ends the
  attempt at the first unrecognised screen with Esc. A prompt without a
  version banner is `unsupported_version`.
- A key reaches a dialog only after the screen has held still for 600 ms
  (Claude Code drops keys for 250 ms after a dialog opens). Yes is sent at
  most once per call, only when at least 30 s are left for the answer;
  `inspectLimitResets` never sends it.
- On Claude's older reset program (one 5-hour reset a week, no kinds),
  opening any `/limit-reset` while the account is at its 5-hour limit spends
  that reset with no dialog, kind or no kind. So unless the caller passes
  `fiveHourLimitConsent: true` (the person accepted that), OAR reads usage
  through claude's own `accountUsage` right before the first command and
  types it only when the `five_hour` window is below 100%
  (`consent_required` at the limit, `not_attempted` / `usage_unread` when
  the read fails). A `five_hour` redeem skips this: asking to spend the
  5-hour reset is itself the consent. A redeem of any kind but `five_hour` also needs
  Claude Code's cached feature flags (`cachedGrowthBookFeatures` in its
  config, the one boolean) to say the newer program is on; a fresh flag
  fetch can still disagree, which is why the usage read stays.
- The claim carries no key OAR can make Claude Code reuse. OAR keeps each
  `idempotencyKey`'s outcome in memory for the life of the process, with no
  limit on how many: the same key gets the first call's answer, never a
  second Yes; the same key
  with another `resetId` rejects. After a restart a retry is a new attempt,
  so a host that got `unknown` reads usage before trying again. A call that
  sent nothing (`not_attempted`, a refusal) is not remembered.

Each call has a cost of its own: the interactive UI sends one model request
at startup (a 1-token check, `max_tokens: 1`; the offline harness recorded
it, `-p` does not send it). On a subscription it most likely counts as
usage and can open a 5-hour window on an idle account (magpie's notes for
2.1.316; not verified on a real account). OAR does not suppress it:
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is reported to stop it but also
usage reads, which `/limit-reset` needs.

`runtime.inspectLimitResets(installation, options?)` (claude only) opens
`/limit-reset <kind>` for `weekly`, `fable`, `full` and, with
`includeFiveHour: true`, `five_hour`, reads each confirmation dialog, and
cancels it with Esc. It is not part of `accountUsage` and must not be
polled: it starts the CLI's UI, and on the older program it can spend (above).
`kind: "inspected"` lists every kind with its `state`: `available` (with
`resetsLeft` and `expiresText`, claude's own words such as "Nov 19,
4:59pm", when the dialog shows them), `none`, `not_offered`, `unknown` (a
screen after it was not recognised, so nothing more was typed) or
`not_checked`. `program: "legacy"` says the older program answered (it has
only the 5-hour reset and says nothing more); `fiveHourSpent: true` says it
spent that reset when the command opened, which only consent allows.
`version` is the banner's. The same `reauth_required` (no login),
`unsupported` (`endpoint_unavailable` when this account's Claude Code
answers "Unknown command: /limit-reset") and `not_attempted` outcomes apply.

A redeem's `nothing_to_reset` is claude's "saved for when you reach a usage
limit" line, or the older program's "isn't available right now" for a
`five_hour` request; `no_reset` is its "No … reset to use" line. `unknown`
with `fiveHourSpent: true` is the older program spending its 5-hour reset
for a request of another kind (only with consent).

Evidence: an offline harness drove the real 2.1.322 UI against a fake
backend in a network namespace (Raft team, 2026-11-10, 21 scenarios);
the recognisers are tested against its recorded screens
([driver](../../packages/oar/src/runtimes/claude/limit-reset/driver.ts),
[tests](../../tests/claude/claude-limit-reset-driver.test.ts)). No real
account's reset has been spent through OAR, and the real server's labels
for the Fable and full kinds are not verified.

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
request in it included. The call rejects at the deadline; processes it started
continue their normal owned shutdown in the background and may remain alive
for the stop grace period (10 seconds by default) before escalation to SIGKILL.
This also applies to Codex `redeemLimitReset` (a timeout is a rejection, see
above). Claude's limit-reset calls instead answer with a typed outcome
(`not_attempted` or `unknown`) when their `timeoutMs` runs out, after
ending the UI process. Reasons do not include tokens, credential values, or raw provider responses.

Kimi rejects an unreadable response body, invalid JSON, or a response with no
usable quota windows. A window with a malformed present usage metric is omitted;
other valid windows remain. A missing native `used` metric retains its zero
meaning, while an invalid value never becomes zero. Malformed Extra Usage data
does not supply a window or override exhausted subscription limits. Only an
absent credential file is `credentials_missing`; file I/O failures and malformed
credential contents reject with a safe reason, without token bytes or file paths.

Grok's email lookup is optional. After billing has arrived, its identity query
ends 100 ms before the overall deadline, or is skipped when less time remains.
Failure or timeout of that query returns the billing result without an email;
process cleanup continues in the background. Failure to obtain billing before
the overall deadline still rejects.

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
