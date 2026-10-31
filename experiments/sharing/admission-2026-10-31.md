# Shared-process admission decisions

Runtime version check: 2026-10-31.

Grok 1.0.70 and OpenCode 2.2.3 and 2.2.5 meet the native evidence gate on **Linux x64,
macOS arm64 and Windows x64**. OpenCode's admission requires **one session
per canonical directory for the entire native process lifetime**, including
after release. Other versions and architectures do not inherit admission.
This report records native admission. OAR enables OpenCode 2.2.3; adding
2.2.5 to these decisions does not enable that adapter version. Other native
adapters remain isolated until separately implemented.

## Decisions and evidence

| Exact runtime | Linux x64 | macOS arm64 | Windows x64 | Required adapter boundary |
| --- | --- | --- | --- | --- |
| Grok 1.0.70 | admitted | admitted | admitted | Native per-session cleanup and explicit child attribution; configuration/trust controls below |
| OpenCode 2.2.3 | admitted with directory restriction | admitted with directory restriction | admitted with directory restriction | Each canonical directory belongs to only one session per process lifetime |
| OpenCode 2.2.5 | admitted with directory restriction | admitted with directory restriction | admitted with directory restriction | Same lifetime directory restriction; separate product enablement pending |
| Codex 0.166.0 | not admitted | not admitted | not admitted | Persisted hook-trust changes untested; loaded-session resume model behavior needs an adapter rule |

Grok's [original admission report](admission-2026-10-30.md) records seven of
seven observations on each platform in the second run, complete resources,
lower shared memory and no higher shared CPU. Its same-directory/release
checks passed in [run 41149607090](https://github.com/botiverse/oar/actions/runs/41149607090)
and the latest run below. The latest external native trust grant and
cross-directory controls close the remaining configuration gap.

OpenCode's [updated-version report](updated-versions-2026-10-30.md) records
seven of seven observations and complete resources on each platform, with
lower shared memory and CPU. The latest cross-directory project discovery
and user-configuration refresh controls close the freshness gap. Its
same-directory MCP checks still fail: B replaces A's registration, and the
registration survives closing both sessions. This is not an unrestricted
same-directory pass. A used directory must select a fresh isolated process
for `auto`, or refuse explicit `shared`, even with identical or empty MCP
servers. The restriction lasts until the shared process exits.
The [cold-start database race](../../docs/runtimes/opencode.md#startup-and-compatibility)
remains an independent known limitation across processes.

OpenCode **2.2.5** has its own [complete three-platform report](opencode-2.2.5-2026-10-31.md)
from [run 41221951609](https://github.com/botiverse/oar/actions/runs/41221951609),
main `7c888bdd353cb996b4db96d3a593886677cfae08`. All seven native groups,
cross-directory project discovery and user-configuration refresh complete on
each platform. All 18 post-turn resource windows are exact, with lower shared
memory and CPU. Its same-directory failures match 2.2.3: registration
replacement and retention after native close. The same lifetime directory
restriction is therefore required. This admission preserves 2.2.3 and does
not admit other versions or architectures.

Codex's Windows hooks now execute after the explicit PowerShell invocation
fix. Same-directory checks and all four per-session trust controls pass on
all three platforms. The Windows main comparison has six hook records in
each of the shared and separate-process cohorts. These controls exercise
session parameters, not persistent hook-trust changes. That gap and the
[loaded-session resume model limitation](codex-2026-10-29.md) remain;
passing this run does not admit Codex.

## Earlier six-runtime three-platform observations

[Run 41157633349](https://github.com/botiverse/oar/actions/runs/41157633349)
used main `56e0fda10a2ccf9f316d4888a8a8eab974a1c99a`, six exact runtime
versions on the three platforms above, with `same_directory_only=true`.
All 18 artifacts were checked. This run repeats same-directory observations
and adds the Grok/OpenCode freshness controls; it does not repeat resources
or the earlier lifecycle observations. Those conclusions retain their
sources above. The [probe methods](trust-freshness-2026-10-31.md) describe
the ordering, positive controls and failure conditions.

| Runtime | Same-directory result on all three platforms | Additional controls on all three platforms |
| --- | --- | --- |
| Grok 1.0.70 | MCP, release, instruction markers and hooks pass | External native `grok --trust` grant, cross-directory user-hook refresh and project-hook discovery all match a fresh process |
| OpenCode 2.2.3 | MCP crossover and post-close retention; markers/hooks agree | Cross-directory project discovery and user-level instruction/plugin refresh both match a fresh process |
| Codex 0.166.0 | MCP, release, instruction markers and hooks pass | Four trust controls pass: both trust directions, shared/separate, with A invoked again after B |
| Kimi 2.4.1 | Later shared sessions retain old hooks | Immediate instruction markers also differ in this run on all three platforms; stale hooks fail everywhere |
| Qoder 1.1.81 | MCP crossover and missing instruction markers | No admission; hook agreement cannot replace missing instruction evidence |
| Antigravity 1.4.5 | MCP/release and hooks agree; instruction markers missing | No admission; missing observations remain missing |

Grok's original same-directory probe disables folder trust. Its new native
grant control leaves trust enabled, proves the untrusted A baseline, grants
trust through a separate native process while A stays alive, then opens B.
Both cross-directory scenarios also use native trust grants. In the user-hook
scenario, already-open A retains hook A in both cohorts after the file changes;
new B reads hook B. The gate concerns the newly opened session.
OpenCode's user control rewrites the same user-level instruction and plugin
files after A opens, then opens B in a distinct project without observer
files. This establishes refresh, separately from project discovery.

### Artifact provenance

Each artifact contains `same-directory-<runtime>/evidence.json`. Grok and
OpenCode also contain `configuration-freshness-<runtime>/evidence.json`.
The native commands, disposable homes and scripted providers are the ones
committed at the run's exact main SHA. Missing or differing observations
remain failures in those files, including the expected non-admitted results.

| Runtime and platform artifact | Artifact ID |
| --- | --- |
| antigravity-Linux-X64 | [13025213521](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025213521) |
| antigravity-Windows-X64 | [13025233693](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025233693) |
| antigravity-macOS-ARM64 | [13025638694](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025638694) |
| codex-Linux-X64 | [13026091954](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13026091954) |
| codex-Windows-X64 | [13025901621](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025901621) |
| codex-macOS-ARM64 | [13026031924](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13026031924) |
| grok-Linux-X64 | [13026211851](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13026211851) |
| grok-Windows-X64 | [13025349160](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025349160) |
| grok-macOS-ARM64 | [13025682209](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025682209) |
| kimi-Linux-X64 | [13026152058](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13026152058) |
| kimi-Windows-X64 | [13025872761](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025872761) |
| kimi-macOS-ARM64 | [13025533186](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025533186) |
| opencode-Linux-X64 | [13025721688](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025721688) |
| opencode-Windows-X64 | [13026101312](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13026101312) |
| opencode-macOS-ARM64 | [13025114350](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025114350) |
| qoder-Linux-X64 | [13026006253](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13026006253) |
| qoder-Windows-X64 | [13025781710](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025781710) |
| qoder-macOS-ARM64 | [13025623993](https://github.com/botiverse/oar/actions/runs/41157633349/artifacts/13025623993) |

## Implementation order

OpenCode 2.2.3 is the first enabled adapter, with its directory restriction;
Grok follows. OpenCode 2.2.5 admission requires a separate version-table and
CI update. Kimi remains deferred for stale hooks. Codex remains in the
second group. A separate adapter change must enforce exact version/platform
admission, retain an explicit isolated path, validate its OAR lifecycle and
routing, and document its first default `auto` sharing release. This report
is evidence admission, not a switch that enables sharing.
