# Pi bootstrap prompt admission

A Pi SDK extension can start a run from `session_start`, before OAR returns
its session. OAR now subscribes before binding extensions. This preserves the
run's actual start, keeps direct prompts busy through an awaited settlement
hook, and lets held inputs run after settlement and compaction. It also
retains a run that finishes entirely during startup.

Pi RPC 1.5.0 still has an upstream visibility gap in this scenario. Its server
subscribes after binding extensions and can lose a deferred prompt's response.
The existing OAR 30-second command timeout rejects the input and cleans up the
child. This change does not claim to fix RPC or infer admission from an
unrelated extension error.

## Reproduce

Run from the repository root after `pnpm install`, on Node 24 or newer:

```sh
OAR_TEST=pi-aimock pnpm tsx experiments/pi-bootstrap-admission/probe.ts
OAR_TEST=pi-rpc-aimock pnpm tsx experiments/pi-bootstrap-admission/probe.ts
OAR_TEST=pi-aimock pnpm vitest run sea-trial/vendor/pi-bootstrap-admission.vendor.test.ts
```

The probe uses the installed native SDK or RPC child, an isolated Pi agent
directory and a loopback model server. No account, paid provider or global
runtime configuration is used. An optional final argument selects its output
directory; the default is `oar-trial-run/pi-bootstrap-admission`. RPC takes
about 30 seconds because the probe observes the existing timeout rather than
shortening it. Output contains raw local paths and generated session IDs;
review it before publishing.

The [fixture](../../sea-trial/vendor/support/pi-bootstrap.ts) holds the first
`agent_settled` extension hook behind a file gate. Its model request has
finished, but the hook has not returned when OAR opens. The probe submits `D`,
then releases the gate. The hook starts a real compaction and returns while
compaction is still active. The probe checks the compaction completion marker,
records D's response or the observation limit, and attempts `NEXT` only after
D has a response. It waits for RPC's actual `exited` record before `NEXT`.
The 100 ms delay before releasing the file gate gives RPC command delivery
room; the gate, not that delay, holds the native settlement hook.

## Native cause

In native 1.5.0 `dist/core/agent-session.js`, `_emitAgentSettled` marks the run
inactive before awaiting extension hooks. During that await, `prompt()` adds
the input to the deferred action list and returns immediately, before its
preflight callback. After the hook, the deferred action checks whether
compaction is active and throws before invoking that callback. The throw
rejects the extension-owned bootstrap invocation; it is not a response to D.
Neither a fulfilled prompt promise nor an uncorrelated `extension_error`
establishes D's admission or refusal.

`dist/modes/rpc/rpc-mode.js` binds extensions before installing its event
subscriber. `get_state.isStreaming` is false during this settlement hook,
and the native protocol exposes no hook-in-progress state or correlated
response for the deferred refusal. Keeping OAR's transport deadline is honest;
turning the extension error into D's native receipt would not be.

The published [1.5.2 package](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.5.2.tgz)
was also inspected on 2026-11-15. It still has that deferred-return branch,
compaction refusal before preflight and RPC subscribe-after-bind ordering.
This is source inspection only, not a native 1.5.2 result.

## Observed results, 2026-11-15

Linux x64, Node 24.19.0, native SDK and RPC 1.5.0. The initial source was OAR
`e9e1df1f3d623fd02d51516be7b23fafc415ce67`. The selected evidence is in
[`selected.json`](selected.json); each case includes its raw source SHA-256.
Raw logs and full captures remain in the author's task evidence directory.
The committed records are only those cited below, with their original seq,
request IDs and input IDs. Omitted seq values are intentional selection gaps.
The summary abbreviates the synthetic BOOT padding; selected records are unchanged.

| Case | Evidence | Result |
| --- | --- | --- |
| SDK before the change | `sdk-before`, request seq 3; frames 4 through 7 | Open incorrectly appeared idle. D was still pending after 2116 ms, although compaction completed. No D input hook ran. The only refusal was `send_user_message`'s uncorrelated extension error. |
| SDK after subscribing first | `sdk-after`, frame 2; request/response 16/17 | Open appeared running from the actual `agent_start`. D returned `busy` in under 1 ms and was never submitted to Pi. |
| SDK recovery | `sdk-after`, frames 18 through 20; records 21 through 24 and 35 | BOOT's real settlement and compaction completed. NEXT was admitted by its own callback and completed. No terminal outcome was invented for D. |
| RPC unchanged | `rpc-unchanged`, frames 5/6; responses 9/10/12 | The extension error did not identify D. Its control rejected `error` after 30003 ms, then an actual `exited` response arrived. NEXT rejected `runtime_exited`. |

The earlier RPC capture stopped immediately after D's refusal and saw `NEXT`
reject busy while cleanup was starting. It did not prove process exit. The
final capture above explicitly waited for `exited` and is the exit evidence.
The before-change SDK capture observes a two-second pending interval, not an
unbounded-duration test; source inspection explains why its callback never
arrives on this path.

## Regression coverage and retained failures

The [new native cases](../../sea-trial/vendor/pi-bootstrap-admission.vendor.test.ts)
cover three independent outcomes:

1. A held bootstrap settlement rejects D before submission, holds queued input
   through compaction, then runs the queued input once and allows NEXT.
2. A bootstrap run completed within `session_start` retains its actual start
   and end, and does not own the next input.
3. Aborting an active bootstrap model request preserves its aborted outcome
   without cancelling NEXT.

All three passed with the fix. Restoring the two product files to the original
commit made all three fail: the two active cases incorrectly appeared idle,
and the already-completed case had no terminal record. The original test
limits and native outcomes were retained.

The first new test run had a test-author mistake: it checked `queued` on the
outer control result instead of its recorded response body. That failure is
retained. The full native suite also exposed two fixture assumptions that
needed explicit updates: the native tool-selection helper must now call
`bindExtensions` itself, and an existing bootstrap test must expect the real
start event to be retained. Its overtaking, settlement and recovery checks
remain unchanged. These failures are not counted as successful runs.

The runtime change is confined to SDK startup ordering. Model validation and
credential registration still precede extension binding, and a binding
failure still disposes the native session through the bounded lifecycle.
RPC code, prompt deadlines, error attribution and cancellation policy are
unchanged.

Final validation on the submitted implementation: `CI=1 pnpm run check`
passed type checking, lint, 4,371 tests and 18 mock behavior checks. Native
SDK vendor checks passed 124 cases; RPC passed 115. The public behavior suite
passed 17 cases with two capability-based skips for each mode. Cross-platform
CI results belong to the pull request; these observations are Linux only.

A [proposed upstream issue](upstream-issue-draft.md) records the minimal
RPC sequence and requested correlated refusal; it has not been submitted.
The follow-up unit coverage also emits bootstrap events directly from
`bindExtensions` and checks model refusal at the session-construction layer.

The follow-up unit cases retain both an active bootstrap run and one already
completed during binding. Moving binding before the subscription makes both
fail because no real start is retained; the product was restored afterward.
The complete follow-up gate passed type checking, lint, 4,373 tests and
18 mock behavior checks. No RPC code or cancellation behavior changed.
