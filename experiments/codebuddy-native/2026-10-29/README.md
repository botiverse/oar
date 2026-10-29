# CodeBuddy native ACP, international login and consecutive prompts, 2026-10-29

Runtime: CodeBuddy 2.178.1. Account helper: task #60 draft based on
`cf66cd24e04a2ca85eef6b973b3aa9f631e8223b`. ACP adapter and native-provider
suite: task #60 branch based on `45411a0`.

## Account observation

`status.json` and `login.json` came from the portable OAR helper on a second
Linux x64 computer with Node 24.22.1. They contain only version and state data.
The initial status read was logged out. The earlier helper classified one
login as rejected before
exposing an authorization URL; the helper's fresh post-login read was still
logged out. No real model prompt was sent.

On xxwork, a HEAD request to each of `https://www.codebuddy.ai/` and
`https://www.codebuddy.ai/v2/plugin/auth/state` returned curl exit 28 after an
8.01-second connection attempt, with no HTTP status. No authentication state
was created. The second computer's operator reported TLS unexpected EOF at both
the international homepage and the authentication path (curl exit 35, HTTP 000).
A third operator reported HTTP 404 for HEAD at the same two URLs. The helper
then returned `logged_out` and produced an international authorization URL on
Linux arm64, Node 24.18.1 and CodeBuddy 2.178.1 with an isolated HOME.
`arm64-status.json` and `arm64-login.json` preserve that operator's reports:
the login observation lasted 85.899 seconds and ended with `failed / rejected`;
the fresh account read was still `logged_out`. This duration includes the
helper's checks, not just the native authentication request. The URL was sent
privately to the account owner; whether it was opened and what the browser
displayed are unconfirmed. The cause of this failure is unknown. There was
no successful authorization at that point. A second authorized attempt
(`arm64-login-second.json`) also returned rejected after 81.892 seconds.

The third attempt succeeded (`arm64-login-success.json`): logged out before,
logged in afterward. A separate process confirmed logged in
(`arm64-status-after.json`), then one real conversation completed with the fixed
answer (`arm64-chat.json`, input 6,730 and output 8). That earlier draft used a
stream-json conversation helper; the counts are not an ACP token ledger. The
selected ACP adapter reports `usage().total: null`. These reports verify only
international login, status and one short conversation on Linux arm64 with
Node 24.18.1 and CodeBuddy 2.178.1. Logout, refresh, domestic service and other
platforms were not covered. No credentials or account identifiers were copied.

`auth-source.json` records the inspected binary and source constants: the native
external-link flow has a five-minute overall deadline and one-second polling;
provider failures can be folded into a generic `auth_failed`, which the OAR draft
incorrectly reported as rejected. The adapter now returns `process_failed`
for `auth_failed` or control failures, preserving a sanitized reason; native
timeout and cancellation remain distinct. The first two arm64 failures remain
unexplained. Their
state-only reports cannot prove user denial or a particular polling failure.

## Environment-key account projection

`auth-environment.json` records a fresh-HOME probe of native 2.178.1 with a
synthetic `CODEBUDDY_API_KEY` and localhost endpoint. `initialize.account` was
an object, despite no browser login or credential validation. No object fields,
credentials or account identifiers are recorded. Reproduce from the repository
root with:

```sh
OAR_CODEBUDDY_BIN=/absolute/path/to/codebuddy OAR_PROBE_OUTPUT=/private/path/report.json pnpm tsx experiments/codebuddy-native/auth-environment.ts
```

Consequently a non-empty effective environment key yields OAR `unknown` with
`configured: ["environment: CODEBUDDY_API_KEY"]`. Without the key, the native
account query remains authoritative for local browser-login state. Unit tests
cover inherited, overridden, removed and empty keys, both with and without a
stored account.

## Native consecutive-prompt reproduction

`codebuddy-consecutive-prompts.mjs` retains the protocol and timing of the
2026-10-26 script; braces, declarations and lint annotations were polished for
the repository. The recorded checksum identifies the original executed script. It runs CodeBuddy in bubblewrap with a fresh HOME and a local mock
provider; it does not use OAR, account credentials or an external model service.

```sh
node codebuddy-consecutive-prompts.mjs /absolute/path/to/codebuddy 0
node codebuddy-consecutive-prompts.mjs /absolute/path/to/codebuddy 1000
```

| Delay after first result | Runs | Provider request order | Result frames |
| --- | --- | --- | --- |
| 0 ms | 3 | first, second, second | 2 |
| 1,000 ms | 3 | first, second | 2 |

Every run initialized, exited with code 0 and stayed within the existing
60-second bound. `consecutive-results.json` retains all six sanitized results;
`environment.json` records the version and archive/script checksums. The native
stream-json duplicate execution remains present with this custom endpoint.
The later ACP experiment below
therefore selected a different native interface without adding a delay.

Upstream: [CodeBuddy issue 1847](https://cnb.cool/codebuddy/codebuddy-code/-/issues/1847).


## Provider response delay controls

`codebuddy-stream-response-delay.mjs` keeps the second input immediate while
changing only the local provider's response delay:

```sh
node codebuddy-stream-response-delay.mjs /absolute/path/to/codebuddy 0 500
node codebuddy-stream-response-delay.mjs /absolute/path/to/codebuddy 0 1000
node codebuddy-stream-response-delay.mjs /absolute/path/to/codebuddy 0 2000
```

`stream-response-delay-results.json` contains three runs at each delay. Two
500-ms runs duplicated; one timed out after the first result. All three runs at
1,000 ms and all three at 2,000 ms duplicated. This contradicts a claim that only
near-instant model replies trigger the failure.

Separately, the maintainer reported four immediate official-account controls
(two with partial-message output) and one 1-second control with one append per
input, not two. No official-account identity or transcript is shared here. The
cause is unknown; the custom endpoint/API-key path is a candidate difference,
not a proven explanation.

## ACP controls and implementation

`codebuddy-acp-consecutive-prompts.mjs` directly drives native ACP without OAR:

```sh
node codebuddy-acp-consecutive-prompts.mjs /absolute/path/to/codebuddy 0
node codebuddy-acp-consecutive-prompts.mjs /absolute/path/to/codebuddy 1000
```

Three immediate runs and three one-second controls passed, with exactly two
conversation provider calls and two prompt answers. The fixture recognizes
native title-generation requests by their system instructions and reports them
separately. `acp-consecutive-results.json` retains every run, update kind and
safe RPC error code. Both scripts use Linux bubblewrap, an isolated writable
HOME, a read-only host filesystem and synthetic localhost credentials.

The OAR adapter uses native ACP for sessions and keeps the private stream-json
account helper. Its shared behavior suite passed 16 cases; account usage and
two steering cases skipped for absent capabilities. Its native vendor tests
verify consecutive prompts and retained history, same-ID resume after process
exit, native shell cwd after resuming in another directory, HTTP 401 failure rather than false success, prompt replacement/tool denial,
and stdio/HTTP MCP credentials on new/resumed sessions. The credential test
also scans native HOME after shutdown; neither synthetic credential persisted.

Run the maintained regressions with the installed binary:

```sh
OAR_CODEBUDDY_BIN=/absolute/path/to/codebuddy OAR_TEST=codebuddy-aimock pnpm sea-trial
OAR_CODEBUDDY_BIN=/absolute/path/to/codebuddy OAR_TEST=codebuddy-aimock pnpm vitest run sea-trial/vendor/codebuddy.vendor.test.ts
```

### International-account ACP

`arm64-acp.json` came from `../acp-real.ts` bundled with this adapter and run by
the maintainer on Linux arm64, CodeBuddy 2.178.1. A private status read found the
existing login. Two immediate short prompts each returned their requested
marker; after process disposal, the same session ID resumed and a third marker
matched. The entire probe lasted about 35 seconds. No account identifier,
credential, raw native frame or authorization URL is in the report.

Usage total was null. Context was native 0/0 with percent null. In the inspected
2.178.1 binary, `AcpUsagePublisher.doPublish` sets used and size to zero when it
has credit usage but lacks the context limit, then awaits publication at prompt
end. OAR preserves those native values; it does not conclude the real context
is empty. The profile regression separately asserts no update means null.

### Interface limits observed in native source

The native model config option reports its current selection; the thought-level
menu describes that model, not every catalog entry. The model setter
acknowledges acceptance but its returned config does not strictly confirm the
requested selection; OAR applies it without claiming that readback. Effort
requires a matching native readback. Native mode setters can
persist settings, so the adapter uses the process launch permission flag.
Known vendor notification names come from `ExtensionMethod` and
`extNotification` calls. They remain native records, with authorization links
redacted. `ACP_META_STEER_CLIENT_META` participates in user-message broadcast and
replay; it is not evidence of a callable steering method. Goal and UI extension
methods were not adopted as OAR controls. The question and delegateTool methods
are native requests, not registered notifications. Attribution remains opaque.

The selected paths and limits are documented in
[CodeBuddy](../../../docs/runtimes/codebuddy.md). WorkBuddy remains outside this
verification. Continue monitoring issue 1847 for the unselected stream-json
conversation path.
