# Shared runtime process evidence

These probes exercise native multi-session transports with scripted local
model responses. They do not enable OAR process sharing. The admission rule
is [system.md, Shared runtime processes](../../docs/design/system.md#shared-runtime-processes).

- [OpenCode plugin child cwd counterexample and admission withdrawal](opencode-plugin-environment-2026-10-31.md).
- [Grok stdio MCP and native child execution-environment controls](execution-environment-2026-10-31.md).
- [Grok experimental adapter and child arrival timing](grok-child-order-2026-10-31.md).
- [Current version/platform admission decisions](admission-2026-10-31.md).
- [OpenCode 2.2.5 historical three-platform evidence](opencode-2.2.5-2026-10-31.md).
- [Native trust refresh, cross-directory controls and latest platform results](trust-freshness-2026-10-31.md).
- [Configuration coverage and complete failure diagnostics](configuration-coverage-2026-10-30.md).
- [Same-directory MCP and configuration freshness](same-directory-2026-10-30.md).
- [Completed Codex/Qoder resource follow-up](followup-2026-10-30.md).
- [Updated versions and probe follow-up](updated-versions-2026-10-30.md).
- [Platform admission and resource comparisons](admission-2026-10-30.md).
- [Codex 0.165.0 observations](codex-2026-10-29.md).
- [ACP and Qoder observations](acp-qoder-2026-10-29.md).
- [Selected measurements](selected-2026-10-29.json), with no account data or raw transcripts.
- [First three-platform run and probe corrections](portability-2026-10-30.md).

The older native MCP comparisons used **different directories**. They do not
prove same-directory isolation or that later sessions see freshly changed
project/user configuration. No adapter is admitted by those observations
alone. The current adapter enablement is listed below.

The [updated-version report](updated-versions-2026-10-30.md) and
[completed follow-up](followup-2026-10-30.md) cover different-directory
observations and resources for Codex 0.166.0, Antigravity 1.4.5, Kimi 2.4.1
and OpenCode 2.2.3 on Linux x64, macOS arm64 and Windows x64. Their Qoder
1.1.81 contribution is Windows resources only. Qoder's Linux/macOS resources
and all three platforms' different-directory observations, along with Grok
1.0.70, are in the [admission report](admission-2026-10-30.md).
Other versions do not inherit these results.

The workflow now collects OpenCode **2.2.5**, whose ordinary Linux checks
are in the [October 31 daily report](../runtime-version-checks/2026-10-31.md#opencode-225).
Its [earlier three-platform evidence](opencode-2.2.5-2026-10-31.md) covered
resources, routing, lifecycle and configuration, but not plugin child cwd.
**OpenCode 2.2.3/2.2.5 and Grok 1.0.70 are not admitted on any platform.**
OpenCode configured plugins and Grok configured stdio MCP can start children
in shared HOME rather than the session directory; hidden configuration
prevents an options-only guard. OpenCode `auto` is isolated and explicit
`shared` is refused. Candidate adapters and manual controls are experiments.
The [current admission report](admission-2026-10-31.md)
links each decision to its observation, resource and configuration evidence,
including all 18 artifacts from run 41157633349.

OpenCode still crosses same-directory MCP registrations and retains them
after close. A directory already used on a shared process must select a
fresh isolated process for `auto`, or refuse explicit `shared`, even with
identical or empty MCP servers. The cross-directory project and user-level
refresh controls now pass on all three platforms. Grok's external native
trust grant and cross-directory user/project hook controls also pass there.

Codex 0.166.0 now passes same-directory checks and all four per-session trust
controls on all three platforms, including executed Windows hooks. It is
still not admitted: persisted hook-trust mutation is untested and loaded
resume model behavior needs an adapter rule. Kimi 2.4.1 retains stale hooks;
Qoder 1.1.81 crosses same-directory MCP registrations and lacks instruction
markers; Antigravity 1.4.5 lacks instruction markers. These gaps remain
failures or missing evidence, never a complete pass.

Run from the repository root with Node 24 and the pinned executable installed:

```sh
OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/sharing/codex.ts
OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/sharing/codex-resources.ts
OAR_KIMI_BIN=/absolute/kimi pnpm tsx experiments/sharing/acp.ts kimi
OAR_KIMI_BIN=/absolute/kimi pnpm tsx experiments/sharing/acp-resources.ts kimi
OAR_QODER_BIN=/absolute/qodercli pnpm tsx experiments/sharing/qoder.ts
OAR_QODER_BIN=/absolute/qodercli pnpm tsx experiments/sharing/qoder-resources.ts
OAR_OPENCODE_BIN=/absolute/opencode pnpm tsx experiments/sharing/same-directory.ts opencode
OAR_GROK_BIN=/absolute/grok pnpm tsx experiments/sharing/configuration-freshness.ts grok
OAR_OPENCODE_BIN=/absolute/opencode pnpm tsx experiments/sharing/configuration-freshness.ts opencode
```

ACP also accepts `grok`, `opencode` and `antigravity`, with the corresponding
`OAR_GROK_BIN`, `OAR_OPENCODE_BIN` and `OAR_ANTIGRAVITY_BIN` overrides. Each
program accepts an optional output directory after its runtime argument, or
after its filename for Codex/Qoder. Resource probes accept a final session
count (default 10). Output defaults to ignored `oar-trial-run` directories.

The fixtures use disposable home/configuration directories and synthetic
credentials. Only model responses are substituted: protocol handling, tools,
MCP, child agents, persistence and processes are native. Detailed JSON files
are created with mode 0600 where the platform supports it. They can contain
local paths and native synthetic-account startup fields; review before sharing.
The committed evidence keeps only conclusions and resource numbers.

An `observed: true` result means that observation ran successfully. For example,
a refused duplicate resume is a successful observation, not a successful
resume. Read the value and report. Assertion failures produce nonzero exit
status after saving evidence. Process-fault cleanup separately reclaims the
fixture's previously identified descendants; it is not counted as native
per-session cleanup.

The manual [Shared runtime evidence workflow](../../.github/workflows/shared-runtime-evidence.yml)
collects the same observations on Linux, macOS and Windows at explicit versions.
It is outside the ordinary pull-request gate and is not an admission switch.
It must first exist on the default branch before dispatch. A failed or missing
platform run remains missing evidence, even if another platform passes.
The same-directory and resource steps run after a successful native
installation even when an earlier observation fails. Each step retains its
own failure status and evidence;
there are no automatic retries. Each step has a 12-minute limit inside a
80-minute job limit. To fill only missing Windows resource cells, dispatch with
`runtimes=["codex","qoder"]`, `platforms=["windows-latest"]` and
`resources_only=true`. Alternatively, `same_directory_only=true` runs only
the same-directory MCP and project/hook observations, Grok native trust grants,
and Grok/OpenCode cross-directory and child-environment controls, each with
separate-process controls. `execution_environment_only=true` restricts
Grok/OpenCode to actual MCP, hooks/plugins and tool cwd/environment controls.
All three scope flags are mutually exclusive. `opencode_version` selects
exact 2.2.3 or 2.2.5 for the native experiment, without changing production
admission. The default runs up to five observation steps, including resources
after a known same-directory or child-environment failure. These options do
not replace earlier native observations.

Each Windows probe first prepares PowerShell and CIM with one real query,
bounded to 60 seconds, before creating a runtime fixture or measuring resources.
It writes `windows-process-table-preparation.jsonl` in that probe's output
directory and prints the same timing/result to the job log. Preparation failure
fails the probe. Its process-table result is discarded; later failed reads
still fail, and earlier failures remain in the evidence. These runs measure
prepared process services, not first-use latency; the separate
[CIM experiment](../windows-cim/README.md) retains the cold observations.

The reports retain raw cwd markers and compare both paths after
`realpathSync.native`, ignoring case on Windows. Native request and condition
waits record their start, limit, elapsed time and outcome under `waits`;
installation failures also save an evidence file. Windows probe waits are
three times the Linux/macOS limits. Codex readiness/version and Qoder version
probes allow 60 seconds on Windows. These are manual evidence budgets, not
changes to OAR's installation or session defaults. The scoped-cleanup tools
have a five-minute lifetime so the probe can inspect native cleanup before
the fixture's own timer expires.

Resource runs open ten sessions, execute one local-model turn in each, wait
five seconds, then sample three five-second idle windows. RSS includes each
native process tree. CPU is CPU-time delta divided by wall time, expressed as
percent of one core. Windows uses working set and process CPU time; macOS uses
RSS/CPU time from `ps`; Linux uses `/proc`. Windows/macOS process-table sampling
adds overhead. Compare only the same version and platform. Exited processes
make a CPU interval a lower bound. For a no-higher-CPU comparison, an isolated
cohort's lower-bound windows may be included as a conservative reference:
its true CPU can only be higher. A shared cohort's lower-bound windows must
be excluded, since its true CPU might exceed the reference. Report the exact
window count separately on both sides, the medians/ranges actually compared,
and whether the isolated reference includes lower bounds. An absent exact
shared sample cannot establish the gate. This refines the original rule that
excluded lower-bound windows on both sides; earlier selected values remain
unchanged. See the [Codex Windows calculation](followup-2026-10-30.md#cpu-comparison-rule). These short idle samples do not prove long-running
memory stability, active-workload CPU parity, or a universal threshold.

The Windows resource reader enumerates processes, then selects requested PIDs.
A PID that exited is absent, including an empty array when all requested PIDs
exited. A genuine enumeration/property failure or malformed output still fails
the measurement. This avoids `Get-Process -Id` discarding valid rows because a
different requested PID already exited.

Process-table and Windows resource reads use experiment-owned 60-second
subprocess limits and retain actual wall time in `process-table-reads.jsonl`
and stdout. CIM includes its internal query duration. Errors, malformed rows
and missing observer identity remain failed evidence, with no fallback to an
empty table. Linux procfs retains the product reader's structural validation,
without a subprocess deadline. No command lines, environment values or raw
CIM output are saved in these diagnostics. Cleanup failure is retained beside
the cohort before exiting nonzero; no further cohort then starts. Product
query limits are unchanged. Windows public `resources()` still returns null;
these numbers come from the experiment.

Codex crash injection identifies the actual executable in the owned launch
root or its direct children, then rechecks PID/start identity before signaling.
It records candidate names and the selected identity. This supports both
POSIX exec-replaced roots and Windows child binaries; a missing or ambiguous
match fails rather than guessing a PID. See the updated-version report for
the original failed observations and local product cleanup validation.
