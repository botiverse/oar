# Native CI investigation closeout

Runtime version check: 2026-11-07. This closes the bounded investigation of
the [November 6 failures](README.md), with three observations still active.
OpenCode's slow successful Windows prompts were localized to native snapshot
tracking. The original CodeBuddy install timeouts, Antigravity MCP mismatch
and intermittent Grok initialization timeouts remain unexplained.

## Diagnostic retention

| Diagnostic and tests | Decision | Evidence and next decision point |
| --- | --- | --- |
| CodeBuddy npm debug/timing capture; `tests/codebuddy/install-diagnostics.test.ts` and the smoke regressions | Keep in the ordinary installation smoke. | Five ordinary Windows successes took approximately 169, 140, 118, 83 and 87 seconds. The requested sample minimum is met, but none captures a 180-second timeout. Inspect the next natural timeout's last npm operation before deciding on a fix or removing capture. |
| ACP provider requests, matcher selections and streamed replies; `tests/provider-evidence.test.ts` | Keep for all four synthetic ACP providers. | The original macOS Antigravity mismatch had no provider journal. A natural recurrence must distinguish the returned script from native tool execution. Reassess capture and its tests after that comparison; passing jobs alone do not answer it. |
| Grok's seven post-suite launches and bootstrap phases; `tests/grok/bootstrap-trace.test.ts` | Keep in the ordinary Windows observation workflow. | No observed first-launch timeout followed by its same-HOME retry has been captured with phase records. Later successful probes do not observe a suite process that timed out. Reassess after that paired sample. If the three-minute step ceiling is reached, reduce attempts rather than raising it. |
| Automatic OpenCode native-log copying; `tests/opencode/native-log-evidence.test.ts` | Remove the normal fixture hook and its three dedicated tests. Keep the bounded copier only in the manual snapshot experiment. | The snapshot interval is localized, and the four changed vendor files now pass on Windows with native snapshots enabled. No continuing automatic copy is needed for that question. Use the manual experiment if a new failure specifically needs these native phase markers. |

Review the three retained diagnostics on **2026-12-07**, with **Cindy owning
the decision**. If a required sample has not arrived, the default is to remove
that diagnostic and its dedicated tests, record "not observed again; cause
unknown", and restore it from Git history if the failure recurs. This does
not count as a fix. If failures are still occurring but the probe has not
captured its target sample, revise its placement at that review instead of
continuing to wait with the same probe.

The retained tests guard diagnostics that still execute, including truncation,
original-error preservation and observer failures. The removed tests guarded
the retired automatic copy. The manual
[comparison](opencode-first-prompt.ts) explicitly calls the relocated
[copier](opencode-evidence.ts) before disposing its fixture HOME. Its bounds
remain four files and 1 MiB per file, with head/tail gaps and omissions in
the manifest. It changes no native logging or snapshot setting.

These are ordinary-run observations, owned by Otter with Cindy reviewing
the next decision. Do not dispatch extra workflows just to fill the sample
count. The next relevant failure triggers evidence inspection; absence of
a recurrence is not proof that the original failure was fixed. Keep the
CodeBuddy smoke's 180-second install, 240-second child and five-minute step
limits; the product's default install limit remains 600 seconds. Keep Grok's
15-second initialization and five-second cleanup limits. No workflow,
matcher, assertion, test deadline or product behavior changes in this cleanup.

## OpenCode: Windows validation completed

The [snapshot report](opencode-snapshot.md) retains the original successful
Windows intervals of about 9 to 159 seconds inside native `add()`/`write-tree`
preparation. It does not separate Git, filesystem, CPU or scheduling cost.
PR #681 moved the four MCP/failure vendor files to small Git projects, without
disabling snapshots. Their first Windows observation then exposed a real
saved-directory comparison bug: the temporary parent's 8.3 spelling differed
from the native listing's long spelling. PR #683 fixed the shared comparison
with `realpathSync.native`; the raw fixture input and refusal assertions stayed.

The subsequent
[Windows OpenCode job](https://github.com/botiverse/oar/actions/runs/42311306143/job/128213127757)
passed all ten native cases, including attach/resume. Eight vendor first
snapshots took 235 to 288 ms from `initialized` to `tracking`, followed by
1.307 to 1.869 seconds to the agent stream. The shared behavior fixture's
19.453-second snapshot is a separate sample and is excluded from that range.
The [selection](closeout-selected.json) retains source log hashes, artifact
identity and each vendor timeline, without paths or native session IDs.
Recompute them with [native-snapshot-timeline.py](native-snapshot-timeline.py).

At main `929bd86e`, all
[39 required checks](https://github.com/botiverse/oar/actions/runs/42320021832)
and [three Windows ACP jobs](https://github.com/botiverse/oar/actions/runs/42320021880)
passed. Its [OpenCode job](https://github.com/botiverse/oar/actions/runs/42320021880/job/128242044355)
again passed the ten vendor cases, with no slow or failed
`opencode-vendor-cwd` cleanup record. These verify the smaller fixtures and
directory fix; they do not establish a remedy for every historical timeout
or predict large-repository performance for hosts.

## What remains unresolved

The [CodeBuddy selections](windows-followup.md#codebuddy-and-next-decisions)
show unpacking dominating three successful installations. The earlier
uninstrumented timeouts cannot be attributed to that phase. Five successes
are sufficient for the agreed initial sampling; more dedicated runs are
unnecessary.

The [Antigravity report](README.md#antigravity-the-scripted-providers-decision-was-not-archived)
keeps the original missing `clash-user` failure and ten successful Linux
controls. No new evidence identifies a premature matcher decision or a
native omission. The provider recorder remains necessary for this distinction.

Grok still failed two shared cases at initialization in
[main job 128225418265](https://github.com/botiverse/oar/actions/runs/42315029120/job/128225418265),
then passed all seven later controls. The OAR path took 5.703 seconds on its
first launch and 328 ms on reuse; the observed Node path took 8.236 seconds
and 343 ms. Those controls used different processes after the suite and do
not explain the failing launches. The next main job passed; this does not
erase the retained failure. Raw evidence identifiers are in the selection.

Several independent failures encountered during the investigation received
bounded fixes: the fake Kimi login writer retries Windows `EPERM` while
preserving its old JSON; the paused-host abort test uses a fixture that
cannot complete cancellation before the forced-exit assertion; image fixture
cleanup uses the existing bounded-wait helper; and the watchdog fixture
waits for the reporter's actual case record before blocking its worker.
The [watchdog evidence](../windows-watchdog/README.md#windows-validation)
confirms its named timeout and process termination on Windows. None of these
explains CodeBuddy, Antigravity or Grok's original failures.

One image-only fixture removal previously remained pending after five
seconds without a final record. PR #686 and its main Codex jobs passed both
image cases without another such record. Keep that count at one and inspect
process/file occupancy if it recurs naturally. Separate pending `codex-home`
records still exist; a pending deletion alone does not identify the lock
holder or prove a surviving native process.

## Cleanup validation

On Linux x64 with OpenCode 1.19.5 and Node 24.19.0, all ten ordinary vendor
cases passed with no `native-opencode` directory; incremental ACP provider
records remained. The manual comparison completed eight tool turns and
retained four complete native logs, with no omissions or truncation. Its
identity, counts and raw-result digest are in the selection above.
The full commit gate passed: typecheck, lint, 3,668 unit tests and 18 mock
behavior cases.

The earlier Windows observations validate the merged fixes, not this new
removal of the copy hook. Cross-platform results for the cleanup come from
its own CI.
