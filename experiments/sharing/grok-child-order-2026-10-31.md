# Grok shared adapter and child arrival timing

Runtime version check: 2026-10-31.

Grok 1.0.70 (`f50904eaee6c`, stable), Node 24.19.0, a local Linux x64 host.
Model replies use a local scripted provider and disposable configuration;
Grok's session, subagent, transport and process behavior are native.
This supplements the [three-platform admission decision](admission-2026-10-31.md),
not a new version or platform admission.

## Native child ordering

The [probe](grok-child-order.ts) records decoded incoming JSON-RPC before
SDK dispatch, with a monotonic timestamp and wire sequence. Two root sessions
share one native connection. A spawns a foreground child while B prompts
independently. Each configured child-model delay runs three times, sequentially
within one connection. The probe requires a spawn pair matching the completed
result, child traffic, and no unexpected host requests; missing evidence fails.
The [selected output](selected-grok-child-order-2026-10-31.json) retains all
12 samples and the child/lifecycle timing, but no transcript or account fields.

| Scripted child delay | Samples | Spawn lead before first child frame, min / median / max (ms) | Completed result after first child frame, min / median / max (ms) |
| --- | --- | --- | --- |
| 0 ms | 3 | 68.19 / 68.68 / 75.98 | 140.30 / 145.96 / 152.73 |
| 250 ms | 3 | 69.79 / 71.62 / 83.43 | 380.80 / 394.04 / 395.08 |
| 1500 ms | 3 | 71.08 / 72.62 / 78.09 | 1617.96 / 1627.02 / 1627.86 |
| 5000 ms | 3 | 69.77 / 74.45 / 76.81 | 5119.03 / 5121.99 / 5123.85 |

All samples have ten child-addressed frames. In all twelve, the earliest
explicit relation is `_x.ai/session_notification` / `subagent_spawned`,
with `parent_session_id` and `child_session_id`. It precedes the first child
frame (`_x.ai/mcp_initialized`). The completed tool's
`rawOutput.subagent_id` agrees in every sample, but arrives much later.
The older October 29 report emphasized that late result and omitted the
already available spawn relation; its analysis is now corrected.

The adapter therefore uses spawn to establish ancestry. It uses completed
results only to check an already accepted direct parent/child pair. A conflict
retains the original ownership and records a redacted diagnostic. No explicit
native field correlates the spawn to a tool-call id here; OAR does not guess
which concurrent sibling tool call produced a particular spawn.

The 1-second, 256-frame, 1-MiB buffer allows reordering, not tool completion.
These timing measurements are Linux-only. The native shared/isolated
lifecycle regression on each admitted platform asserts that the association
already existed when child frames arrived, or arrived within 1 second. It
also requires a child text projection, excludes that child from the peer's
records, and compares completed ancestry. Synthetic regressions deliberately
put child frames and permissions first, let them expire, close the connection,
and supply conflicting cross-root ancestry.

## Adapter verification

The Linux shared behavior suite passed 17 cases, with two capability skips
(account usage and the model-list-dependent effort menu). The real native
shared and isolated lifecycle controls both passed. They cover:

- Concurrent same-directory roots with distinct native models and scoped MCP
  registrations, plus project cwd reported by an actual command.
- Native child execution and arrival timing, cancellation with a surviving
  peer, and same-directory reuse after releasing the first root.
- Two live hosted terminal trees before disposal. Disposing A cleans A's
  tree and leaves B's alive. Disposing final lease B cleans its tree and
  exits the native process. Final fixture reclamation found no live residual
  processes in either cohort.
- New-directory MCP ownership, complete MCP call-log duplicate checks, and
  resume after native exit.

Synthetic public-adapter tests additionally cover exact installation and
running-version refusal, simultaneous refused opens, executable version
changes between pool lifetimes, initialization/environment pool separation,
fixed allow permission policy with child request ids, unknown-request refusal,
occupied/retired resume, abort fallback, and one exit per attached root.
The shared connection records late ancestry conflicts through its existing
credential-union redactor. Connection diagnostic summaries retain counts only.

Windows/macOS adapter lifecycle results come from this change's PR CI; this
report does not replace them with the Linux result. Native admission on those
platforms remains supported by the separate reviewed runs in the admission
report. The new jobs use the same exact Grok version and retain failure data.

Reproduce:

```sh
OAR_GROK_BIN=/absolute/grok pnpm tsx experiments/sharing/grok-child-order.ts
OAR_GROK_BIN=/absolute/grok OAR_TEST=grok-shared OAR_TEST_REQUIRE_AVAILABLE=1 pnpm sea-trial
OAR_GROK_BIN=/absolute/grok OAR_TEST=grok-shared pnpm vitest run sea-trial/vendor/grok-sharing.vendor.test.ts --maxWorkers 1
```

The first command writes selected evidence, raw wire and response JSON under
`oar-trial-run/grok-child-order`. Only the evidence JSON belongs in the
committed selection. The lifecycle test retains redacted session records,
process diagnostics, child timing and cleanup observations under
`oar-trial-run/grok-sharing` even on failure.

## Release behavior

Grok is the first native adapter whose default `auto` placement shares without
a lifetime directory restriction. Only stable 1.0.70 on Linux x64, macOS
arm64 and Windows x64 is enabled. Hosts choosing `withPlacement("isolated")`
retain independent processes. Grok's per-session fixed allow policy is
unchanged. Other versions, unsupported platforms and unaudited startup inputs
remain isolated under auto; explicit sharing receives a typed placement refusal.
