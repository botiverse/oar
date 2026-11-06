# OpenCode first-prompt snapshots

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

Windows and macOS results belong to the next ordinary CI runs; no special
observation workflow is added. After merge,
check whether these four files still time out, retaining any original and
new failures rather than treating faster passing samples as causal proof.

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
