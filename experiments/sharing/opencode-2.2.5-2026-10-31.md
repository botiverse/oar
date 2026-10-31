# OpenCode 2.2.5 shared-process evidence

Runtime version check: 2026-10-31.

OpenCode **2.2.5** meets the native sharing evidence gate on **Linux x64,
macOS arm64 and Windows x64**, with the lifetime directory restriction below.
Each platform retains the same-directory MCP crossover and
post-close registration retention already observed in 2.2.3. These results
establish admission under the existing **one session per canonical directory for
the entire process lifetime** restriction, including after release. They do
not support unrestricted directory reuse.

This is an evidence admission decision, not adapter enablement. OAR's product
admission table and shared-placement CI remain pinned to **2.2.3**. Updating
them requires a separate exact-version change. The earlier 2.2.3 admission
remains valid; the new version does not replace or widen its evidence.

## Source and complete matrix

[Run 41221951609](https://github.com/botiverse/oar/actions/runs/41221951609)
used main `7c888bdd353cb996b4db96d3a593886677cfae08`, Node 24 and
`@opencode/cli@2.2.5`. Both `resources_only` and `same_directory_only` were
false. The probes used disposable homes and local scripted model providers,
with the real native executable, ACP transport, tools and persistence. No
real account credentials or paid model calls were used.

Every native observation reports `opencode v2.2.5` from installation and
`2.2.5` from ACP `initialize.agentInfo.version`. Every directory,
configuration and resource cohort also reports `opencode v2.2.5`.

| Platform | Different-directory native groups | Same-directory MCP | Project discovery / user refresh | Resource cohorts | Artifact |
| --- | --- | --- | --- | --- | --- |
| Linux x64 | 7/7 observed | crossover and post-close retention | 2/2 comparisons pass | 2/2 complete | [13050487013](https://github.com/botiverse/oar/actions/runs/41221951609/artifacts/13050487013) |
| macOS arm64 | 7/7 observed | crossover and post-close retention | 2/2 comparisons pass | 2/2 complete | [13050785762](https://github.com/botiverse/oar/actions/runs/41221951609/artifacts/13050785762) |
| Windows x64 | 7/7 observed | crossover and post-close retention | 2/2 comparisons pass | 2/2 complete | [13050676627](https://github.com/botiverse/oar/actions/runs/41221951609/artifacts/13050676627) |

All three jobs conclude `failure` because their same-directory step rejects
the crossover and retained registration. Their native, freshness and resource
steps succeed. No missing observation is relabeled as a pass, no failed step
is hidden, and no rerun replaces this attempt.

## Native lifecycle and attribution

The seven groups have the following results on each platform:

- Concurrent A/B prompts retain their own cwd and answer; matching MCP server
  names route to the session's own server in different directories.
- A's subagent reaches the scripted provider once. The child answer carries
  an explicit `opencode/child-session` link to A on A's frame, with depth 1.
  B receives no child reply.
- `session/resume` succeeds for the loaded session, retains prior history,
  uses `aimock-model` and completes its next turn with `end_turn`.
- Each session starts a two-process tool tree. Cancelling A yields
  `cancelled`; both A processes disappear while both B processes remain.
  Native close and host terminal cleanup preserve that isolation. B has not
  finished before its own cleanup.
- Concurrent close/resume both return successfully; a subsequent resume and
  prompt complete with `end_turn`.
- Fault injection exits the process while both prompts are pending. Both
  reject with an ACP process-exit error, and neither completed before the
  fault. The exit value is null on Linux/macOS and 1 on Windows.

These are native-protocol observations. The resource/lifecycle probes can
open more than one session in each of their two fixture directories; they
measure the transport and the process, not enforcement of OAR's directory
admission guard. Same-directory MCP is measured separately below.

## Directory restriction and configuration

On every platform, A initially calls its own MCP server. Opening B in the
same directory replaces that registration: A's subsequent and concurrent
calls reach B's server. B continues calling B after A closes. After closing
both sessions and reopening with no MCP servers, the old B server is still
invoked and its result is retained. The separate-process control preserves
the correct routing, and its empty-MCP reopen does not invoke the old server.
Final checks inspect the complete call record, including calls arriving after
their original turn's check.

The same four failure reasons are recorded on every platform: shared MCP
isolation failed; A's later invocation mismatched; A's concurrent invocation
mismatched; and the old MCP server was invoked after close and empty-MCP
reopen. There is no additional failed or missing directory observation in
this run. Both cohorts observe the instruction markers and hooks, and the
new B session agrees with the fresh-process control.

Consequently, a used canonical directory cannot be assigned to another
session on that shared process, even after release or with an empty/identical
MCP list. The existing automatic isolated fallback and explicit-shared refusal
are necessary boundaries for any 2.2.5 admission.

The separate freshness probe runs two comparisons, each with a shared and a
fresh-process cohort:

| Scenario | Change after A opens | B's observed result on all three platforms |
| --- | --- | --- |
| Project discovery | Write revision B instructions/plugin in B's distinct project directory | B instructions and hook B, matching a fresh process |
| User configuration refresh | Rewrite the same user-level instructions/plugin from A to B, then open B in a distinct project with no observer files | B instructions and hook B, matching a fresh process |

Both comparisons retain correct MCP calls and native tool results for every
turn. The project scenario establishes first discovery, not refresh of a
previously read project. The user scenario establishes refresh after a
process has already read that same user configuration. On A's later turn,
project hooks remain A, while user hooks become B in both cohorts; the latter
turn's history contains both old and new instruction markers. OpenCode records
two hook calls per input, for outer `execute` and the inner invocation; this
is symmetric in the shared and fresh-process controls.

## Resources

Each cohort opens ten sessions, executes one scripted turn per session,
settles for five seconds and measures three further five-second windows.
Values below are median (minimum to maximum). Memory is whole-process-tree
MiB, POSIX RSS or Windows working set. CPU is percent of one core.

| Platform | Isolated MiB | Shared MiB | Isolated CPU % | Shared CPU % | Valid CPU windows, isolated/shared |
| --- | --- | --- | --- | --- | --- |
| Linux x64 | 3607.86 (3598.06 to 3659.93) | 394.61 (393.03 to 402.61) | 8.37 (7.78 to 10.57) | 2.79 (0.80 to 3.99) | 3/3 |
| macOS arm64 | 3888.25 (3886.94 to 3889.61) | 490.47 (490.42 to 490.48) | 15.49 (8.55 to 15.63) | 1.98 (1.78 to 4.92) | 3/3 |
| Windows x64 | 3748.80 (3745.74 to 3752.91) | 387.84 (387.83 to 390.23) | 9.17 (7.64 to 10.17) | 1.40 (0.56 to 2.80) | 3/3 |

All 18 post-turn windows have `cpuIsLowerBound=false` and
`exitedDuringWindow=0`; none is excluded, and the isolated reference uses no
lower-bound windows. Both cohorts complete cleanup without a recorded error.
Shared memory and idle CPU are lower on each platform in these samples.
This does not establish active-workload CPU parity or long-running memory
stability. Windows/macOS process sampling adds observer overhead, as described
in the [measurement rules](README.md).

The [independent cold-start database race](../../docs/runtimes/opencode.md#startup-and-compatibility)
is not fixed by these results. The [daily 2.2.5 report](../runtime-version-checks/2026-10-31.md#opencode-225)
retains its concurrent cold-start failures and separate cold-resume MCP
limitation; neither is relabeled by the loaded-resume observation here.

## Retained evidence and reconstruction

The three downloaded archives were checked against GitHub's SHA256 digests.
The [manifest](opencode-2.2.5-2026-10-31.manifest.json) retains their ids,
digests, run/commit/job identities, step conclusions and the SHA256 of each
of the twelve input evidence files. The [selected JSON](selected-opencode-2.2.5-2026-10-31.json)
retains native outcomes and attribution/cleanup facts, complete selected
directory/configuration turns and every resource window. Raw transcripts,
temporary paths, native session ids and process ids are excluded.

Download each named artifact into the indicated platform subdirectory of an
empty `downloaded` directory, then rebuild the selection:

```sh
stamp run download 41221951609 --repo botiverse/oar \
  --name shared-evidence-opencode-Linux-X64 --dir downloaded/Linux-X64
stamp run download 41221951609 --repo botiverse/oar \
  --name shared-evidence-opencode-macOS-ARM64 --dir downloaded/macOS-ARM64
stamp run download 41221951609 --repo botiverse/oar \
  --name shared-evidence-opencode-Windows-X64 --dir downloaded/Windows-X64
python3 experiments/sharing/select-acp-admission-evidence.py \
  experiments/sharing/opencode-2.2.5-2026-10-31.manifest.json selected.json \
  --input-root downloaded
cmp selected.json experiments/sharing/selected-opencode-2.2.5-2026-10-31.json
```

The selector verifies every input hash before selecting fields and fails on
missing or changed files. It reuses the existing directory-evidence selector;
it neither applies an admission verdict nor discards lower-bound resource
windows. Resource comparisons must apply the window rule stated above.
