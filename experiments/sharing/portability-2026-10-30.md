# Shared-process probe portability: 2026-10-30

The first [three-platform run](https://github.com/botiverse/oar/actions/runs/40977768820)
used Codex 0.165.0, Kimi 2.4.0, Grok 1.0.70, OpenCode 2.2.1,
Antigravity 1.4.4 and Qoder 1.1.81 with isolated synthetic configuration
and local model responses. Linux completed all six observations and resource
runs. The other platforms still need a complete passing run; the failures
below do not establish a session isolation violation.

| Evidence | What failed | Probe correction |
| --- | --- | --- |
| macOS cwd, all six runtimes | `/var/folders/...` was compared literally with `/private/var/folders/...` | Resolve both paths through `realpathSync.native`; retain both original spellings. |
| Windows cwd, Antigravity, Kimi and OpenCode | Short or differently cased directory spellings failed literal comparison | Resolve both paths and compare without case sensitivity. A different canonical directory still fails. |
| Windows Antigravity and OpenCode cleanup | The native tool result contained a PowerShell `ParserError`: a quoted Node executable was sent without `&` | Generate literal PowerShell arguments with the call operator for these two runtimes. This is a command failure, not evidence of a slow tool start. |
| Windows Codex installation and Grok connection | Codex `app-server --help` reached its 15-second installation limit; Grok later reached a 30-second initialize limit | Increase manual Windows probe budgets and record individual waits. Setup failures now save their evidence. |
| Windows Qoder exit injection | A process identity assertion failed before the kill signal | Target the identified daemon root, not its arbitrary first child. Retain the creation-time identity check and record the fault, transport exit and each turn's settlement time. |
| macOS and Windows resources | Observation failure caused the workflow to skip resource collection | Run resource collection independently after installation, still failing and retaining evidence on errors. |

The Qoder timestamps were process creation times, not session completion
times. `connect()` previously selected the daemon's first child as the native
target. On Windows, OAR unwraps the npm shim before launching, so the root
Node process is the daemon itself; a child can be a transient helper. The
saved identity and the later process-table identity differed by about twenty
seconds, so the guard refused to send the signal. That run supplies no
evidence about turn settlement after a crash. The revised probe records
`msAfterFault` for each active turn and verifies both turns are still active
before injecting the crash.

Codex's 15-second readiness timeout, and the earlier Qoder 15-second version
timeouts in [main CI](https://github.com/botiverse/oar/actions/runs/40929438269),
also represent a real Windows host startup risk. Larger manual probe limits
do not resolve that product risk or identify its cause. Track it with the
existing Windows startup observations, separately from sharing admission.

These changes only repair evidence collection. They do not enable sharing,
change the product timeouts, or infer child-session ownership. A subsequent
main-branch workflow must still establish the corrected Windows/macOS
observations and same-platform resource comparisons.

Local validation on xxwork (Linux x64) after these corrections passed all
six native observation programs at the versions above. In Qoder's fault
sample, both active turns ended about 69 ms after the daemon kill signal.
The three resource programs (Codex, ACP using Kimi, and Qoder) also completed
with two sessions per cohort as a collection smoke test. This smaller run
does not replace the ten-session, three-platform admission measurements.
Unit regressions reject a different canonical cwd and missing tool output,
accept filesystem aliases, and retain timeout evidence before fixture setup
completes. The PowerShell argument round-trip regression requires Windows.
