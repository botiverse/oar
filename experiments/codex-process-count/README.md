# Codex process counts before fixture startup

On November 12, Codex 0.167.2 could finish the scripted `START_EARLIER`
turn before its yielded command reached the Node fixture. In a controlled
shell-delay probe, four matching processes were one Bash process and its
three waiting subshells. The Node fixture subsequently started once, using
the original Bash PID after `exec`. One native command-start frame and two
provider requests were recorded per turn.

This disproves the test's assumption that turn completion implies fixture
startup. It does **not** identify the extra processes in the original CI
failures: those runs retained only PIDs. The controlled probe deliberately
adds shell work; it is not a reproduction of the GitHub runner's startup
configuration. [Selected observations](evidence.json) retain that distinction.

## Original failures and ordinary controls

Both failures below happened immediately after `START_EARLIER`, before the
turn being tested or any call to `abort`. One failing case had process cleanup
disabled. They do not demonstrate an abort-cleanup defect.

| CI job | Earlier-command counts | Preserved evidence |
| --- | --- | --- |
| [PR #756, Ubuntu](https://github.com/botiverse/oar/actions/runs/43288137052/job/131426894393) | Expected 1; observed 6 and 4 | Full job log and 22 artifact files; no command lines for these failed cases |
| [PR #759, Ubuntu](https://github.com/botiverse/oar/actions/runs/43299620290/job/131466973244) | Expected 1; observed 4 and 4 | Full job log and 22 artifact files; no command lines for these failed cases |

Both jobs' archived native records identify Codex 0.167.2. PR #759 used
Ubuntu 26.04.1 and Node 24.22.2. A PID's numerical value does not establish
its age or parentage.

On xxwork, the complete vendor run at `f7538e5a` passed 79 tests, including
the synthetic process-count test. Additional reduced probes passed 12 rounds
per row below. Every round recorded one command-start frame, two provider
requests and one marker match in all six process snapshots.

| Control | Environment |
| --- | --- |
| Original older-process body | Ubuntu 24.04.4, Node 24.19.0, CPU affinity limited to one CPU |
| Node version matched to CI | Same host and affinity, Node 24.22.2 |
| Clean session HOME | Node 24.22.2, isolated HOME and CODEX_HOME |
| Original `ps` command first | Same clean configuration, `ps -A -o pid=,args=` before the detailed snapshots; all original counts were also 1 |
| Ubuntu 26.04 container | Node 24.22.2, procps-ng 4.0.4, two CPUs, isolated HOME and CODEX_HOME |

The container used Ubuntu image digest
`sha256:065aa8626841f16057b78b027b464cd59c4fac36c204c72dcbf48d66f5fa8a96`.
It shares the host kernel and does not duplicate a GitHub runner. These
passing controls do not erase or explain the CI failures.

## Repeat the native probe

Use an installed Codex and a new private output directory on Linux or macOS:

```sh
OAR_CODEX_BIN=/absolute/path/to/codex \
  pnpm tsx experiments/codex-process-count/probe.ts /private/new-output \
  --clean-home --legacy-first --slow-shell
```

This runs two turns against a local scripted provider, without login or
paid inference. Each command first starts three Bash subshells that
wait for three seconds, then executes the Node fixture. Codex receives
`yield_time_ms: 250`. The probe keeps the completed-turn snapshot, five
later snapshots, and a final sample after the shell delay. Both observed
rounds had counts `4,4,4,4,4,4,1`, and the fixture's own startup file held one
PID. The four early rows are Bash, not four copies of the Node fixture.

Omit `--slow-shell` for 12 ordinary rounds. `--clean-home` changes only the
session's HOME to a disposable directory; CODEX_HOME is always isolated by
the local-provider harness. `--legacy-first` adds the old `ps` read before
the detailed read, so those two snapshots are not simultaneous. The script
alternates the cleanup option but never calls `abort` on a successful turn.
A 30-second prompt timeout may abort a stuck probe.

Raw files include local paths, session records and synthetic provider
messages. HTTP request headers are excluded. Keep the output private; the
committed JSON contains selected fields with machine-local paths replaced.

## Test correction and remaining investigation

The older fixture now appends its PID to a startup file. The vendor test
waits up to ten seconds for exactly one reported startup, then retains the
original exact-one process assertion. The overall 180-second case limit,
abort semantics, descendant checks and survivor assertions are unchanged.
A second real fixture launch remains a failure. All process matching now
uses the same full-width process-table reader.

A synthetic Bash regression holds three subshells behind a file gate. The
old immediate count fails with four matches while the Node startup file is
absent. After releasing the gate, the startup assertion and exact-one
process assertion pass. The existing duplicate-process regression still
rejects two matching children.

If the session test body fails, the test saves the original assertion, startup file,
matching process rows, session records and provider messages before
disposal. This retains both the assertion's own snapshot and a later capture;
they must not be treated as the same instant. The next natural CI failure
can distinguish pending shell startup from repeated fixture execution.
The original CI cause remains unconfirmed.

The five corrected native abort cases passed on Linux with Codex 0.167.2.
A deliberately wrong expected count exercised the failure path: it retained
42 session records, two provider messages, one startup PID and matching
process details before cleanup. No matching process remained afterward.
The synthetic gate and duplicate-process regressions passed. Native macOS
execution of this correction remains for the required CI job.
