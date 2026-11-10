# OpenCode structured failure names

Checked November 9, 2026 on Linux x64, Node 24.19.0. The native checks used
OpenCode 1.19.5 and 2.2.6 with isolated homes and local scripted providers.
No real account or paid inference was used. Windows and macOS results belong
to the pull request's CI; this report makes no local cross-platform claim.

## Mapping and evidence

[Ancienttwo's PR #710](https://github.com/botiverse/oar/pull/710) adds a
reader for JSON-RPC -32603 `data.errorName`. Its two commits are carried
with their original author. Only six names override the existing message
classifier. Missing, unknown and non-string names return `null` from the
reader, preserving the generic fallback. Open-time errors are unchanged,
and no quota scope or provider status is inferred.

The names and ACP envelope were checked against OpenCode 2.2.6's
[ACP error conversion](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/cli/src/acp/error.ts#L119)
and [session error conversion](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/core/src/session/to-session-error.ts#L34).
Source support and a native observation are different evidence:

| Name | OAR class | Native evidence |
|---|---|---|
| `provider.free-limit` | `quota` | Contributor reports a live observation in PR #710; not rerun here. |
| `provider.go-limit` | `quota` | Source and synthetic tests only. |
| `provider.budget-limit` | `quota` | Source and synthetic tests only. |
| `provider.model-budget-limit` | `quota` | Source and synthetic tests only. |
| `provider.quota` | `quota` | Source and synthetic tests only. |
| `provider.rate-limit` | `rate_limited` | Captured here from native 2.2.6 against a local scripted provider. |

[Selected native results](selected.json) retain the native prompt-error
bodies and OAR outcomes without local paths or session identifiers:

| Local provider reply on 2.2.6 | Native result | OAR result |
|---|---|---|
| Invalid API key, HTTP 401 | -32000, empty data | `auth`, from the existing ACP code rule. |
| Rate limit, HTTP 429 | -32603, `errorName: provider.rate-limit` | `rate_limited`, from the new name table. |
| Low credit balance, HTTP 400 | -32603, `errorName: provider.invalid-request` | `billing`, from the preserved text fallback. |

The rate-limit turn took about 82.6 seconds while the native runtime retried.
No retry or timeout setting was changed. This is a local-provider observation,
not evidence about a real account's limit or reset time.

## Regression checks

The revised contribution alone passed the complete check (3,792 tests and
18 mock behavior cases). The follow-up guards the table with `Object.hasOwn`:
before that guard, `constructor` and `toString` produced function-valued
failure classes, and `__proto__` produced an object-valued class. All three
new regressions failed before the fix and passed afterward.

The final tree passes the complete check (3,802 tests and 18 mock behavior
cases) and both package builds.

The focused suite passes 79 checks, including billing and malformed-name
fallbacks, other RPC codes and both OpenCode profiles. A synthetic ACP process
returns a named error whose message is unclassifiable; both profiles expose
`quota` through the public prompt result. Removing the profile's reader makes
both session regressions fail, so the tests also cover registration.

Native validation with unchanged assertions:

| Runtime | Behavior suite | Vendor suite |
|---|---|---|
| 1.19.5 | 17 passed, 2 capability skips | Full v1 suite: 10 passed; other backends' cases skipped. |
| 2.2.6 | 15 passed, 4 capability skips | Failure-class suite: 4 passed; other backends' cases skipped. |

The v2 run deliberately selects the failure-class suite. The complete vendor
suite contains v1-only protocol assertions, as recorded in the
[runtime page](../../docs/runtimes/opencode.md#verification-and-open-gaps).
Three initial `tsx` commands could not start because the chosen temporary
directory made their Unix socket paths too long. They passed with shorter
temporary paths under `/tmp`; the product and native deadlines were unchanged.

## Reproduce

Select each installed binary explicitly with `OAR_OPENCODE_BIN`; no login is
needed. The existing probe records native frames and outcomes. Its raw files
can include temporary paths, so publish selected results rather than the
whole directory.

```sh
CI=1 pnpm exec vitest run tests/failure-mapping.test.ts tests/acp/acp-session-opencode.test.ts tests/acp/acp-session-opencode-v2.test.ts

export OAR_TEST=opencode-aimock
export OAR_TEST_REQUIRE_AVAILABLE=1
export OAR_TEST_CONCURRENCY=2
export OAR_OPENCODE_BIN=/path/to/opencode-1.19.5
pnpm sea-trial
CI=1 pnpm exec vitest run sea-trial/vendor --maxWorkers=2

export OAR_OPENCODE_BIN=/path/to/opencode-2.2.6
pnpm sea-trial
CI=1 pnpm exec vitest run sea-trial/vendor/failure-classes-acp.vendor.test.ts --maxWorkers=2
pnpm exec tsx experiments/failure-evidence.ts opencode invalid_key rate_limited billing --out oar-trial-run/opencode-error-names --timeout 150
```
