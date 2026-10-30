# Shared runtime process evidence

These probes exercise native multi-session transports with scripted local
model responses. They do not enable OAR process sharing. The admission rule
is [system.md, Shared runtime processes](../../docs/design/system.md#shared-runtime-processes).

- [Codex 0.165.0 observations](codex-2026-10-29.md).
- [ACP and Qoder observations](acp-qoder-2026-10-29.md).
- [Selected measurements](selected-2026-10-29.json), with no account data or raw transcripts.
- [First three-platform run and probe corrections](portability-2026-10-30.md).

Run from the repository root with Node 24 and the pinned executable installed:

```sh
OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/sharing/codex.ts
OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/sharing/codex-resources.ts
OAR_KIMI_BIN=/absolute/kimi pnpm tsx experiments/sharing/acp.ts kimi
OAR_KIMI_BIN=/absolute/kimi pnpm tsx experiments/sharing/acp-resources.ts kimi
OAR_QODER_BIN=/absolute/qodercli pnpm tsx experiments/sharing/qoder.ts
OAR_QODER_BIN=/absolute/qodercli pnpm tsx experiments/sharing/qoder-resources.ts
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
Resource steps run after a successful native installation even when an
observation fails. Both steps retain their own failure status and evidence;
there are no automatic retries. Each step has a 12-minute limit inside a
30-minute job limit.

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
make a CPU interval a lower bound and that interval must not establish a
no-higher-CPU conclusion. These short idle samples do not prove long-running
memory stability, active-workload CPU parity, or a universal threshold.
