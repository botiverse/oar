# OpenCode first-prompt snapshots

The [November 7 closeout](closeout.md) adds the successful Windows resume and
snapshot measurements, and retires automatic native-log copying.

Runtime version check: 2026-11-06. OpenCode 1.19.5, synthetic providers.

Two ordinary Windows main-push observations now localize the long first
prompt interval to native snapshot tracking. The MCP and failure-class
vendor tests move to small temporary Git projects so they no longer wait
for snapshots of the OAR checkout. This is a fixture change, not a fix for
all OpenCode timeouts. Historical failures remain in the
[original investigation](README.md).

## Native Windows evidence

Both OpenCode jobs passed. Each retained eleven complete native logs,
without omissions or truncation, totaling 183,836 and 181,649 bytes.
The [selection](opencode-windows-snapshot.json) includes artifact IDs and
SHA-256 digests, native log digests and timestamps. It excludes the behavior
fixture and retains the eight vendor fixtures in each job that recorded a
first snapshot. The model-unavailable test rejects before this phase.

| Windows job | First `initialized` to `tracking`, eight fixtures | First `tracking` to agent `stream` |
| --- | ---: | ---: |
| [128158677273](https://github.com/botiverse/oar/actions/runs/42295250108/job/128158677273) | 86.467 to 158.806 s | 0.881 to 1.398 s |
| [128158903001](https://github.com/botiverse/oar/actions/runs/42295313820/job/128158903001) | 9.236 to 40.903 s | 1.283 to 1.750 s, seven records |

The second job's eighth fixture has a first snapshot but no subsequent
agent stream record; it is not included in the second range. No missing
record is treated as zero latency. The first job's MCP attach/resume case
spent 158.806 seconds between the snapshot markers on first use. Its next
two runs reached `tracking` 453 and 248 ms after their native loop markers.

In the pinned
[`Snapshot.track` source](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/snapshot/index.ts),
`initialized` follows the initial Git setup and seed, while `tracking`
follows `add()` and `write-tree`. Thus the measured interval is inside that
native snapshot phase, after initialization, not model generation or MCP
execution. `add()` itself includes several Git operations and filesystem
reads. The logs do not separate Git, disk, CPU or scheduling time.
[`SessionProcessor.create`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/processor.ts)
awaits this phase before starting the agent stream; title generation can
already have made a separate provider request.

Recompute native timelines without running a CLI:

```sh
python3 experiments/acp-ci-failures/native-snapshot-timeline.py \
  /path/to/unpacked-artifact selected.json
```

This emits all complete logs with tracking evidence, including behavior
fixtures. Use source digests to match the selected vendor rows. Incomplete
head/tail segments are excluded; inspect the retention manifests for gaps.
Raw files contain native IDs and local paths and remain CI artifacts.

## Fixture change and host boundary

Only the OpenCode branches in these four vendor files select the new
fixture-owned directory:

- `mcp-servers-acp.vendor.test.ts`
- `failure-classes-acp.vendor.test.ts`
- `serve-mcp-tools.vendor.test.ts`
- `mcp-tools-list-changed.vendor.test.ts`

Each fixture initializes its own Git repository with one staged README.
The same directory survives disposal and resume until fixture cleanup.
Directory cleanup uses the same helper as the Codex fixture: it waits at
most five seconds for `rm` with the existing retries, then lets deletion
continue. Pending, late success and failure are recorded in the trace and
job log as `fixture_directory_cleanup`, including directory and purpose
(`opencode-vendor-cwd` or `codex-home`). Cleanup failure cannot change a
native assertion's outcome. The wait still counts toward the test's time
limit. Repeated slow or failed project deletion needs investigation; it
does not by itself prove a process survived disposal.

Native snapshots stay at their default; the provider configuration does
not set `snapshot: false`. The generic subject helper takes an explicit
optional cwd and otherwise keeps using the current directory. Other
runtime branches retain their prior cwd. Existing time limits, assertions,
MCP credentials, tool scripts and resume checks are unchanged.

These tests verify MCP and failure classification, not large-repository
snapshot performance. The existing
[large-repository/default/disabled/small-Git/plain comparison](opencode-first-prompt.ts)
and its [Linux results](windows-followup.md) remain reproducible. The
`snapshot: false` branch stays an experiment-only diagnostic control.

Hosts can encounter this same native preparation in a large Git checkout:
these successful Windows 1.19.5 samples took about 9 to 159 seconds in the
snapshot phase before the agent model request. This can look like a stalled
prompt. It is not evidence that every silent prompt is snapshotting, nor a
general timing bound. OAR does not change `snapshot`; hosts configure it
through native OpenCode settings themselves.

## Validation and remaining observation

On Linux x64, all ten OpenCode 1.19.5 vendor cases passed. The nine changed
fixture instances produced native logs naming their temporary Git projects;
seven retain both `initialized` and `tracking`, proving native snapshots
still ran. Their measured intervals were 10 to 52 ms, not a Windows timing
prediction. The existing tests passed all tool, credential, failure and
resume assertions; the temporary project directories were removed afterward.
[Selected local results](opencode-small-git-linux.json) retain native log
digests and timings. Missing markers in the other two logs are not treated
as proof that snapshotting did not occur.

PR #681 passed its Linux and macOS OpenCode jobs. Its first ordinary
[Windows main-push observation](https://github.com/botiverse/oar/actions/runs/42302454917/job/128183393957)
passed nine vendor cases and failed attach/resume at the saved-directory
check. The native session listed the long spelling of the temporary parent,
while the host reused the original 8.3 spelling returned by `tmpdir()`.
OAR incorrectly refused that same directory as another cwd. This is a
product bug exposed by the fixture change, not a timeout or a reason to
canonicalize the fixture's input. That raw spelling remains unchanged.
The job log SHA-256 is
`009716a91fdab011a9e36ca8006cb993d1ae5b0653dad302c32e48c0457d1546`;
artifact `13544678853` has SHA-256
`b4e7c67b5e8ab03dadd81d05adae3fce163a9a2148fb719c0da6f46485586988`.
Raw paths and session IDs remain in the CI artifact.

The shared ACP/DSH directory comparison now uses `realpathSync.native`.
In [Node 24.19.0's JavaScript implementation](https://github.com/nodejs/node/blob/v24.19.0/lib/fs.js#L2608),
`realpathSync` walks links but retains ordinary components' spelling.
The [native Windows lookup](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/fs.c#L2816)
uses `GetFinalPathNameByHandleW` to retrieve the filesystem's normalized
path. A failed lookup retains the existing lexical fallback; distinct
directories are still refused. No blanket lowercasing is added.

The [regressions](../../tests/acp/same-directory.test.ts) cover real links,
distinct directories and missing-path fallback on every platform, plus
actual short names and changed drive/directory casing on Windows. A volume
without a distinct short name explicitly skips that case. Local Linux
checks skip both Windows cases and cannot establish their behavior. The
required Windows `check` job runs them; inspect its pass/skip results
separately. The unchanged OpenCode resume case runs in ordinary Windows
main-push observations after merge. Retain original and new failures rather
than treating passing samples as proof that all snapshot delays are resolved.

Grok and CodeBuddy continue to use natural samples. A new Windows Grok
[initialize timeout](https://github.com/botiverse/oar/actions/runs/42295313820/job/128158902546)
was followed by seven successful startup controls. Those controls did not
observe the failing process, so its cause remains unknown. CodeBuddy now
has five successful install samples, approximately 169, 140, 118, 83 and
87 seconds. The minimum sample count is met, but no instrumented timeout
has been captured. Keep its 180-second test limit unchanged.

At task #200's end, decide the retention of all four diagnostic areas
(CodeBuddy npm logs, ACP provider capture, Grok startup phases and OpenCode
native logs) and their supporting tests together. This change makes no
retention decision and does not add another diagnostic stream.
