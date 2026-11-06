# Native CI follow-up: first Windows provider records

Measured November 6, 2026, after PRs #677 and #678. The new records localize
the OpenCode delay before its first agent model request, and show where one
successful Grok launch spent its time. They do not establish the causes of
the earlier timeouts. No runtime, test or workflow time limit has changed.

## OpenCode: the long wait precedes the agent request

OpenCode 1.19.5 passed both new Windows observation jobs:
[128118912525](https://github.com/botiverse/oar/actions/runs/42283686331/job/128118912525)
and [128124139882](https://github.com/botiverse/oar/actions/runs/42285210473/job/128124139882).
The provider files are complete, with no evidence truncation. These are slow
successful samples, not a newly captured timeout.

| MCP case | First job: title response end to first agent request | Second job |
| --- | ---: | ---: |
| Initial stdio and HTTP tools | 107.839 s | 42.687 s |
| Same-name servers | 158.789 s | 66.047 s |
| Replaced/appended prompts with servers | 70.675 s | 42.337 s |
| Host-served tool | 63.183 s | 42.803 s |

In these eight turns the agent request reached the synthetic provider only
after that gap. The provider then finished its response in 3 to 8 ms. The
first native MCP call completed 1 to 32 ms after its opening tool event.
The first job's initial stdio tool started 108.061 seconds after the prompt;
the resumed turn's tool started after 1.347 seconds. Thus the long interval
in these samples is neither waiting for the scripted response nor executing
the requested MCP tool. It is still too broad to identify one native operation.

[First-job selection](opencode-windows-first.json) and
[second-job selection](opencode-windows-second.json) retain per-request times,
HTTP completion, offered tool counts and matching native tool times. Payloads,
session IDs and local paths are omitted. Recompute either selection from an
unpacked artifact, without executing a runtime:

```sh
python3 experiments/acp-ci-failures/provider-timeline.py /path/to/artifact selected.json
```

The source offers a specific next lead. In 1.19.5,
[`SessionProcessor.create`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/processor.ts)
awaits a native directory snapshot before starting the agent stream.
[`Snapshot.track`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/snapshot/index.ts)
initializes a separate Git index and records the worktree on first use.
These vendor cases run in the OAR checkout; the much faster behavior and
image cases use temporary directories. This is a source-based hypothesis,
not proof that snapshotting consumed the Windows interval.

Real hosts in large repositories also use this native preparation path and
may encounter its cost. OAR leaves the native `snapshot` configuration to
the host. If new logs attribute the delay to `tracking`, the next proposal
is to move these vendor cases out of the repository root, backed by that
evidence, rather than increasing their time limits.

Four sequential Linux controls, each with a fresh HOME and one resumed
turn, did not reproduce the long wait:

| Directory/configuration | First tool turn | Resumed tool turn |
| --- | ---: | ---: |
| OAR worktree, native defaults | 1,435 ms | 917 ms |
| Same worktree, native `snapshot: false` | 853 ms | 760 ms |
| Small Git directory, native defaults | 975 ms | 991 ms |
| Plain directory, native defaults | 735 ms | 837 ms |

All eight turns completed and each returned one successful MCP tool result.
The controls ran in a fixed order without clearing the operating system's
file cache, so their small timing differences are not causal estimates.
[Selected timings](opencode-linux-first-prompt.json) identify OpenCode 1.19.5
and Node 24.19.0. The [reproduction](opencode-first-prompt.ts) preserves raw
session records locally and uses a synthetic provider:

```sh
OAR_OPENCODE_BIN=/path/to/opencode-1.19.5 OAR_TEST=opencode-aimock \
  OAR_TRIAL_RUN_DIR=/path/to/evidence \
  pnpm tsx experiments/acp-ci-failures/opencode-first-prompt.ts
```

The `snapshot: false` branch is only a diagnostic control. The vendor suite,
product defaults and CI do not use it. The experiment has a 120-second turn
guard and reports a timeout as a failure; it is not added to CI.

The OpenCode fixture now retains its existing native `.log` files before
deleting HOME. It changes neither log level nor launch flags. At most four
files, in descending filename order, retain up to 1 MiB each. For a larger
file, separate `.head` and `.tail` segments retain 512 KiB each; the manifest
records exact offsets, bytes, omissions and truncation. Missing logs are an
evidence gap. Copy failure cannot replace the test result or prevent HOME
cleanup, and every opened file is closed before cleanup proceeds.

Logs go to `OAR_TRIAL_RUN_DIR/native-opencode/`, covered by the existing
artifact upload. They contain native session IDs and local paths, so raw
files must stay diagnostic artifacts rather than public report excerpts.
The next ordinary Windows run can correlate native `initialized`, `tracking`
and `stream` records with the provider timeline. A whole-job termination
before fixture cleanup can still prevent this final copy.

Local validation passed: the full check (3,659 unit tests and 18 mock
behavior cases), 17 OpenCode behavior cases, 10 native vendor cases and the
eight experiment turns. The vendor run retained ten native logs totaling
82,233 bytes. Native retention still needs macOS PR CI and the ordinary
Windows main-push ACP observation; the provider timelines above predate
the native-log addition.

## Grok: first successful Windows phase measurement

The [Grok report](../grok-startup/README.md#windows-control-2026-11-06) now
includes the first Windows phases. The OAR path initialized in 5.999 seconds,
then 326 ms in the same HOME. The observed Node path took 5.842 seconds, then
349 ms. All seven launches succeeded; no first-timeout retry result exists
yet. The seven-launch step took 25 seconds, below its unchanged three-minute
limit. If it reaches that limit, reduce attempts rather than increasing it.

## Recording cost: no clear duration increase in these samples

The [selection](windows-followup-selected.json) retains job links/IDs,
step durations, artifact sizes and provider-file budgets. Before and after
jobs run on different VMs and are not controlled measurements of write cost.

| Windows backend | Before: behavior/vendor seconds | After: behavior/vendor seconds |
| --- | --- | --- |
| Grok | 58/201, 53/180 | 54/186, 48/161 |
| Kimi | 61/204, 59/209 | 47/172, 54/191 |
| OpenCode | 81/545 (vendor failed); 121/skipped (behavior failed) | 94/534, 98/354 |
| Antigravity, ordinary PR jobs | 27/122, 21/102 | 27/128 |

Artifact growth is visible. First recorded Windows artifacts were 1.99 MB
for Grok, 1.78 MB for Kimi, 0.49 MB for OpenCode and 0.67 MB for Antigravity;
previous artifacts were roughly 8 to 31 KB. Uncompressed provider files
totaled 8.18, 5.70, 3.02 and 4.02 MB respectively. The largest file was
2.47 MB, and none reached an entry/file cap. Grok's 8.18 MB total spans 26
fixtures; the 8 MiB limit applies per fixture.

These few observations do not show a clear duration increase, but do not
isolate synchronous recording overhead. Keep observing natural runs rather
than treating successful jobs as proof of zero cost.

## CodeBuddy and next decisions

The original recorded install took 169.340 seconds. The next two ordinary
PR Windows samples took 140.076 and 117.990 seconds. Their npm unpack phases
took 157.155, 130.837 and 110.124 seconds respectively, while build/link work
took milliseconds. These are only two subsequent samples of the requested
five to ten; the earlier three 180-second failures remain unexplained.

Keep the 180-second install, 240-second child and five-minute step limits.
No extra workflow is launched to fill the sample count. At task #200's end,
review whether to remove the always-on provider/native capture and Grok
startup probe, including its dedicated tests. That decision remains open
while the first-failure and natural-install samples are incomplete.
