# Qoder 1.1.82: model identity and native replay

The model confirmation can be adapted to a verified new native mapping. The
native replay failure is separate, so fixing confirmation alone will not restore
the Qoder CI suite. The original November 3 investigation made no product change, assertion
relaxation, pin change or upstream publication. The November 5 follow-up below
records the approved CI pin and the separate model-mapping scope.

This is the investigation and proposed scope for task #163, November 3, 2026,
Linux x64. [Selected observations and package hashes](provider-transition-2026-11-03.json) accompany this report.

## Model identity

The published 1.1.82 worker bundle replaces the old server-model catalog with a
ModelProvider manager. In the daemon path used by OAR:

1. A session snapshot carries the selected model key. The native session-host
   projection looks it up through `getModel(snapshot.model)` and puts that
   descriptor's `displayName` in `system/init.model`.
2. `daemon.get_models` lists descriptors from the same manager. Its projection
   puts the descriptor key in both `value` and `modelId`, and the descriptor's
   `displayName` in the response. It no longer constructs `serverModel`.
3. The optional `serverModel` serializer still exists, but no longer supplies
   the field in this native path. This is why simply retaining the old decoder
   rejects the new format.

The existing unmodified-binary control agrees with that source path: requesting
`efficient` produces init `Efficient`; cache and live catalog entries have
`value: efficient`, `displayName: Efficient`, a `modelId` field, and no
`serverModel.display_name`. The selected trace did not retain the `modelId`
value; its equality with the key is established by the source projection and
still needs an explicit wire assertion in the proposed regression. The identical
1.1.81 fixture supplies the old field
and opens successfully. These are synthetic-fixture observations, not an
account-backed catalog or successful paid inference.

**Proposed product change for review:** use the verified 1.1.82 format only on
the new-version path. Require an exact selector lookup, matching `modelId`, a
nonempty `displayName`, and exact equality with the native init name. Preserve
the old-version requirement for `serverModel.display_name`. Do not normalize
names, accept an arbitrary UI label, or treat an invalid selector as confirmed.
Update `listModels().resolvedId` from the same mapping. Keep missing-field,
conflicting-name, missing-selector and private-response regressions, and add
cases that prove 1.1.81 does not inherit the new fallback.

## Replay failure

Both published executable bundles changed in the same way. In 1.1.81,
`getFakeResponseStore` has its definition and two direct callers: streamed
inference and utility generation. In 1.1.82, each bundle retains only the
definition. The CLI option and stored `fakeResponses` configuration remain.
This establishes removal of those direct consumers; it is not a claim about
every possible dynamically loaded provider.

The earlier direct native permission control bypasses OAR model confirmation:
1.1.81 executes its scripted tool after one permission request and reply;
1.1.82 returns native error 10500 before any permission request. That comparison
does not establish a real-provider outage or the cause of the server error.

A new guard control loads unchanged vendor binaries with an isolated synthetic
identity and instruments Node file reads and socket connections. It refuses
non-loopback Node connections from process start. Its selected output is:

| Version | Native outcome | Replay reads | Scripted text | Input/output usage |
| --- | --- | ---: | --- | --- |
| 1.1.81 | success | 1 | present | 17 / 3 |
| 1.1.82 | initialize refused | 0 | absent | no result |

The guard observed attempted non-loopback connections on both versions and
blocked them. On 1.1.82, initialization fails before a prompt can be submitted.
Therefore this guarded comparison proves a new startup dependence in this
fixture; it must not be described as a post-initialize replay execution test.
The earlier permission control and the removed source consumers are separate
evidence. No real login or paid model request was used by the guarded control.

## CI and next decision

PR #619 run `41662458763` has the same 15 model-confirmation failures on Ubuntu
job `126008935505` and Windows job `126008935990`. Neither job ran its vendor
step. At the 15:50 UTC inspection, 21 jobs passed and 12 macOS jobs remained
queued. These failures remain recorded; no retry was requested.

**Proposed test path for review:** first ask Qoder to restore its native replay
consumer or identify the supported replacement for scripted, account-free
inference. The [current custom-model documentation](https://docs.qoder.com/cli/custom-models)
describes an account-catalog BYOK flow, so it is not evidence of an available
account-free local-provider replacement. The
[plugin reference](https://docs.qoder.com/cli/plugins-reference) documents
commands, agents, skills, hooks, workflows and MCP; no model-provider injection
entry has been verified through that surface. A replacement fixture must first
prove the native loop, tools, permission exchange, resume and usage against a
local provider. Patching the vendor bundle or accepting failing native controls
would not satisfy the existing CI contract.

The original investigation separated the version-aware model mapping from native fixture remediation and the daily report. The current requirement for all 35 CI jobs to pass is unchanged.

## Reproduce the guarded comparison

Place the accompanying [probe](provider-transition.ts) and
[Node guard](replay-io-guard.mjs) together under `experiments/qoder-native/` in
OAR at `b4328cc6`. Install dependencies with the repository's frozen lockfile,
then run each unchanged vendor executable in an isolated installation:

```sh
pnpm exec tsx experiments/qoder-native/provider-transition.ts /absolute/qodercli 1.1.81 valid
pnpm exec tsx experiments/qoder-native/provider-transition.ts /absolute/qodercli 1.1.82 valid
```

The probe creates and removes its own HOME, clears Qoder credential overrides,
loads only a synthetic fixture identity, and emits selected fields rather than
raw native account/configuration responses. The guard is a measurement of Node
socket creation, not an operating-system network namespace. The source hashes
in the selected JSON identify the exact npm bundles inspected.

## November 5 follow-up

Cindy approved separating the release blocker from the model mapping.
[PR #623](https://github.com/botiverse/oar/pull/623) pins required CI to 1.1.81,
without changing assertions or deadlines. It is an explicit exception to the
0.87.0 release freeze and precedes release PR #616. Unpin only when native replay
works again, or an officially supported local provider passes all native cases.
Daily probes still run the latest release. Model confirmation is a separate PR
for after 0.87.0 and must use the launch version rule, require a unique display
name, and verify selector/modelId equality on the wire.

The [November 4 evidence](../runtime-version-checks/2026-11-04.md#qoder-1183) adds Qoder 1.1.83: init reports `Efficient`, both cache and live
catalogs report `value: efficient`, `modelId: efficient`, `displayName: Efficient`.
The independent permission replay returns `error_during_execution` with
`HTTP 500: Internal Server Error`, no `error_code: 10500`, zero permission
requests/replies and zero reported usage. This is not a remote-outage diagnosis.

Bugen independently read a Free-account catalog through the native 1.1.83 daemon
on November 5, without any user message or inference. All 15 display names were
unique. The only enabled entry had `value: qfmodel`, `modelId: qfmodel`,
`displayName: Qwen3.8-Flash`; opening that selector and sending only the initialize
control produced `system/init.model: Qwen3.8-Flash`. This establishes catalog/init
identity for that account, not execution or replay compatibility. No account
identity or credential is included here.

The model mapping subsequently landed in [PR #624](https://github.com/botiverse/oar/pull/624).
The [implementation evidence](model-provider-2026-11-05.md) records the additional
uniqueness constraint and native wire assertions. This resolves model confirmation,
not the separate replay failure. No upstream report has been published as part of
this investigation.
