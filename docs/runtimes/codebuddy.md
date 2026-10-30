# CodeBuddy Code

## Native programming interface

CodeBuddy Code exposes its own ACP server through `codebuddy --acp` over
stdio. OAR starts one native process per session and uses ACP `initialize`,
`session/new` or `session/load`, `session/prompt`, `session/cancel`, and
`session/update`. The native session ID is the resume key. Local settings,
credentials and conversation storage remain owned by CodeBuddy.

The selected interface is ACP for conversations and the private bidirectional
stream-json control channel for login and login status. This is a deliberate
split: stream-json consecutive prompts still reproduce duplicate execution
with a custom model endpoint (upstream issue 1847), while the ACP controls
pass. OAR adds no delay between turns. A future transport change requires both
a fixed native reproduction and a capability comparison, not just an upstream
version change. [Official ACP documentation](https://www.codebuddy.ai/docs/cli/acp).

Evidence below identifies CodeBuddy 2.178.1, Linux x64 local-provider tests and
Linux arm64 international-account tests on 2026-10-29. These are observation
baselines, not a compatibility range.

## OAR mapping

`codebuddyRuntime` is in `defaultRuntimes` and has the dedicated
`@botiverse/oar/runtimes/codebuddy` entry. `installPlan()` describes the official
`npm install -g @tencent-ai/codebuddy-code` command on Linux, macOS and Windows;
`install()` runs it only when no usable copy is found. Missing npm or an
unwritable global installation directory returns `missing_tool` or
`requires_privileges`, with the command and
[official installation source](https://www.codebuddy.ai/docs/cli/installation).
The independent binary installer remains a vendor Beta and is not selected.

OAR finds `OAR_CODEBUDDY_BIN`, `codebuddy` on PATH or `~/.local/bin/codebuddy`.
If none is found and no explicit override is set, a bounded local
`npm prefix -g` query adds npm's global bin directory to discovery. This works
even when that directory is absent from a GUI host's PATH, honors the probe's
environment overlay, and does not change PATH. The plan uses the same prefix
query and checks write access before allowing installation. A failed or
timed-out prefix query in discovery returns the original `not_found`;
`installPlan()` and an `install()` that found no usable copy return
`unsupported / location_unknown`, retaining the vendor command and source.
The detail distinguishes query timeout, non-zero exit code, invalid path
output and other local query failures without including npm's raw output.
OAR does not guess the destination or write access. Readiness and version
remain local probes.

On a machine without CodeBuddy, every discovery call can start an additional
`npm prefix -g` process with a 15-second limit. A missing npm skips this step;
a directly found CodeBuddy or an explicit override also avoids it. The query
uses an OAR-owned private cache in the system temporary directory, removed
after success or failure, with npm logging, timing files and update checks
disabled. HOME and Node's installation remain unchanged.

OAR does not expose a CodeBuddy updater, logout, account quota reader or
provider facade. [Installation evidence](install.md#codebuddy-npm-2026-10-29).

| Surface | Native mechanism and OAR behavior |
| --- | --- |
| Open / resume | ACP new/load, native ID and history. Resume was verified after killing the first process and when changing cwd; a native shell ran in the newly requested directory. Host model, effort, MCP and prompt settings are applied again on each open. |
| Prompt / queue | One prompt RPC at a time; held input belongs to OAR, `queue.durable: false`, and can be withdrawn before dispatch. |
| Steer | Absent. No callable immediate-injection contract has been verified. Native `codebuddy.ai/steerClientMeta` appears in user-message broadcast/replay code; that field alone does not establish a steering input API. |
| Abort / dispose | `session/cancel`, with the shared bounded fallback; disposal stops the owned process tree and hosted terminals. Turn completion is not proof that every native background task stopped. |
| Models / effort | `listModels()` opens a disposable ACP session without a prompt, then reads the model config option. Only the current model receives its observed `thought_level` menu. On/off toggles are not effort levels. Open applies the model with `session/set_config_option`; a successful setter reply does not strictly confirm the requested model in the returned config. Effort is checked against native readback and a mismatch rejects the open. Listing failures throw a generic error without native account details. |
| System prompt | Replacement through a mode-0600 file in a private temporary directory, read back before launch and retained until process exit. The prompt text is absent from argv. An empty replacement is refused. Append is refused because no private append-file input was verified. |
| Tool policy | Native `--disallowedTools`; applied on new and resumed opens. `--permission-mode bypassPermissions` selects noninteractive execution for this process, without calling the persistent mode setter. This is not a sandbox. |
| MCP | Host stdio and HTTP entries, including credential overlays, travel in the private ACP open request. New/resumed invocation and record redaction passed; an audit after shutdown found neither synthetic credential in native HOME files. SSE was advertised but was not exercised. Live tool-list change semantics remain unverified and undeclared. |
| Images | Advertised by native initialize and checked by the shared image case. |
| Records | Standard updates remain native frames with shared text, reasoning, tool, model, effort and context projections. Known vendor notifications are recorded without inventing typed UI/task semantics; authorization URLs are redacted. |
| Attribution | `opaque`. No verified child identity mapping or child token ledger is claimed. |
| Failures | A successful prompt RPC can carry `refusal` and `_meta["codebuddy.ai/outcome"]: "FAILED_MODEL_REQUEST"`. Every `FAILED*` outcome or refusal is a failure. The reason preserves the native message or outcome name. Native error category takes precedence over HTTP status: quota, authentication and provider errors are distinguished; network/internal remain unknown. Known credentials are redacted from the reason. |

`env` is applied to installation selection, account helpers, model listing and
sessions. Unsupported goals, additional directories, service tier, final-output
schema, session name, appended system prompt and `userConfiguration: "exclude"`
are refused before opening. Omission or `include` retains the native defaults.
Transport, permission and session-identity flags cannot override OAR through
`launchArgs`. Other native launch arguments keep their native semantics.

### Usage is not a token ledger

ACP `usage_update.used/size` describes context; it does not establish billed
input/output totals. `usage().total` remains null because no reliable ledger is
mapped on this interface. Cost and vendor metadata remain in native records.

[env] The arm64 real-account run reported `used: 0, size: 0`, which OAR preserved
as `{tokens: 0, contextWindow: 0, percent: null}`. [src] In 2.178.1,
`AcpUsagePublisher.doPublish` deliberately fills both context counts with zero
when it has credit usage but cannot determine the model context limit. That
native 0/0 does **not** prove an empty context. Before any context report, or
when a report omits both counts, `contextUsage()` stays null. Regression tests
pin both cases; OAR does not manufacture zeros or a billing total.

## International login

The adapter uses the native stream-json control channel. It initializes a private
account process and sends `authenticate` without a `methodId`, letting the native
provider select its supported method. `auth_url_callback` exposes the browser
authorization URL to the caller; `auth_result_callback` supplies the native
result. After a successful result, OAR opens a new process to read the account
state again. A subsequent `logged_out` contradicts success.

With `openBrowser: false`, the login child gets `BROWSER=true` on POSIX or
`BROWSER=<SystemRoot>/System32/hostname.exe` on Windows. The host environment
and later account processes are unchanged. Native timeout and cancellation
remain `timed_out` and `cancelled`; initialization, control and generic
`auth_failed` errors are `process_failed` with a sanitized reason. Only an
explicit native authorization denial could justify `rejected`; none has been
verified on this interface.

`authStatus()` reads `initialize.account`: an account object is `logged_in`,
`null` is `logged_out`, and a missing or unreadable value is `unknown`. A non-empty
`CODEBUDDY_API_KEY` overrides this projection: status is `unknown` with
`configured: ["environment: CODEBUDDY_API_KEY"]`, never an account or key value.
[env] With a synthetic key, a fresh HOME and a local provider, 2.178.1 returned
an account object without validating that key. Such an object therefore does
not establish a browser login or remote authentication. Removing the key from
the effective environment restores the account query.

A native successful login remains successful if a fresh status read is unknown;
a fresh logged-out result contradicts it. Confirmation shares the login deadline
and cancellation signal. The
token-bearing account object is consumed privately and never returned. Local
status is evidence of stored account state, not proof that the remote service
will accept a model request.

With `CODEBUDDY_INTERNET_ENVIRONMENT` unset, the inspected international product
configuration uses `https://www.codebuddy.ai`. In the inspected 2.173.0 source,
the native external-link provider creates its authentication state with
`POST /v2/plugin/auth/state?platform=CLI`.
The connectivity checks below use HEAD, which does not create a login attempt.
The adapter preserves the native account environment rather than changing regions.

### Observed on 2026-10-29

- On xxwork, HEAD requests to the international homepage and authentication path
  both timed out while connecting to port 443 after eight seconds. No login was
  started there.
- On a second Linux x64 computer, Node 24.22.1 and CodeBuddy 2.178.1 ran the same
  draft's bundled account helpers. The initial read returned `logged_out`.
  The earlier helper classified one login attempt as `failed / rejected` in
  about seven seconds, without
  an authorization URL. A fresh account read still returned `logged_out`.
- That operator separately observed a TLS unexpected EOF at both the
  international homepage and the authentication path (curl exit 35, no HTTP
  status). This is a connectivity failure, but the state-only login report does
  not establish that it is the exact cause of the native failure.
- A third computer returned HTTP 404 for HEAD at the authentication path and
  homepage. On Linux arm64, Node 24.18.1, CodeBuddy 2.178.1 and an isolated HOME,
  the first two authorized login attempts produced URLs but ended with
  the earlier helper's `failed / rejected`; fresh status reads remained `logged_out`. The full helper
  runs lasted 85.899 and 81.892 seconds. The exact failing step is unknown.
- A third attempt on that arm64 computer succeeded: `login` returned
  `logged_in`, a separate process read `logged_in`, and one real conversation
  completed with the expected fixed answer. That earlier draft used a
  stream-json conversation helper, which reported input 6,730 and output 8;
  these counts are not from the selected ACP adapter, whose token total is null.
  The operator confirmed international browser authorization by the account
  owner. No account identity, authorization URL or credentials are included in
  the reports. Credentials remain only on the operator's computer.
- This verifies international login, a fresh-process status read and one short
  conversation on Linux arm64. It does not verify logout, refresh, the domestic
  service or other platforms. ACP sessions are verified separately below.

### Native authentication failure evidence

[src] The inspected 2.178.1 `ExternalLinkAuthenticationProvider` sets a
300,000 ms overall deadline and waits 1,000 ms between polls. After creating
state with POST, it polls `GET /v2/plugin/auth/token`, then
`GET /v2/plugin/login/account`. The token poll continues for native pending code
11217; other token errors end the attempt. The account pending code is 12151.
`AuthenticationManager.login` catches provider errors and returns false;
`authenticate` then reports `success: false` with `auth_failed`. The earlier
helper mislabeled this `failed / rejected`; the adapter now reports
`failed / process_failed`. Historical reports keep the original result.

That result is not evidence that a person denied authorization. It can also
represent a transport, server, polling or other native authentication failure.
The two roughly eighty-second reports neither establish the failed step nor
match the native five-minute overall deadline. The reports deliberately omit
raw native error details that can contain account data. The source audit's
identity and constants are in the dated evidence directory.

See the [dated observations and sanitized reports](../../experiments/codebuddy-native/2026-10-29/README.md).
The portable helper's successful, failed, timed-out and false-success paths were
checked with a synthetic native process; these checks do not stand in for a
real account login.

## Consecutive-prompt evidence and transport choice

[env] The unchanged standalone stream-json reproduction returned
`first, second, second` in all three immediate runs, and `first, second` in
three controls delaying the second input by one second. The custom provider
used synthetic credentials. Slowing that provider's responses did not remove
the failure: at 500 ms, two runs duplicated and one timed out after the first
result; at 1,000 and 2,000 ms, all three runs at each delay duplicated.

A separate operator's official-account stream-json controls did not reproduce
it: four immediate runs (two with partial-message output) and a one-second
control each executed the tool once per input. The cause is unknown. A defect
specific to the custom endpoint/API-key path remains a hypothesis, not a
finding; a fast-response-only explanation is contradicted by the delay runs.

[env] Native ACP, without OAR, passed three immediate and three one-second
controls: exactly one conversation request per input. Native title-generation
calls were classified separately, not mistaken for repeated conversations.
OAR's shared suite passed 16 cases with three capability skips (account usage
and two steer cases). Native regressions cover consecutive prompts/history,
restart/resume, provider 401, prompt replacement/tool denial, and credentialed
MCP on new/resumed sessions. The international-account ACP run on Linux arm64
completed two immediate turns and a third after restart, retaining the same
session ID and the expected answer each time.

The [reproducers and sanitized reports](../../experiments/codebuddy-native/2026-10-29/README.md)
retain these separate observations. Continue tracking
[CodeBuddy issue 1847](https://cnb.cool/codebuddy/codebuddy-code/-/issues/1847)
for the stream-json path; it does not reproduce on the selected ACP path in
these controls. WorkBuddy's bundled CLI and product-specific configuration
remain a separate, unverified integration.
