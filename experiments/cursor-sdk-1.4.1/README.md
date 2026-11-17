# Cursor SDK 1.4.1 acceptance

November 17, 2026, Linux x64, Node 24.19.0. The SDK family moves together
from 1.4.0 to exact 1.4.1: OAR's optional peer and development dependency,
the CLI dependency, the workspace dependency, the installed-version constant,
and the five native platform packages in the lockfile. Historical evidence
baselines are retained.

The repository candidate freezer selected 1.4.1 at 21:48:04 UTC before the
manifest changes. Its exact package URL and integrity are in
[`selected.json`](selected.json), under `candidate`. This was a local frozen
record, not a successful cross-platform daily workflow run. The separate
observer fix locates the SDK skill loader by unique content; 1.4.1 moved it
from the old numbered bundle. Candidate manifest rewriting and version-aware
login assertions are separate infrastructure fixes.

## Live behavior

Using the existing login and `gpt-5.4-nano`, the unchanged
[`live-contract.ts`](../live-contract.ts) ran once from 21:56 UTC. All 12
applicable cases passed: basic, multi-turn, tool detail, busy/late controls,
steer, queue, abort, disposal during a turn, replay cursor, resume, child
attribution, and invalid model. `kill-runtime` is skipped because the SDK
runs inside the host process. See `scenarios` in the selected evidence for
the asserted facts, including `complete_delivered` steering, adapter queueing,
cancelled turns and restored text. Context usage remains unsupported; this
run does not turn cumulative token usage into a context-size estimate.

The unchanged [`cursor-disallowed-tools.ts`](../cursor-disallowed-tools.ts)
then passed its three real rounds once each. Baseline executed shell, MCP and
read; new and resumed restricted sessions executed read only. The MCP callback
count stayed at one after the baseline. These are the `toolDenial` records in
the selected evidence. This probe does not test a child agent's separate toolset.

No scenario was retried. No live macOS or Windows run was performed. These
checks do not rerun manual compaction or establish cloud-agent behavior.

## Usage

The selected `liveRunResults` and `toolDenial.nativeRuns` retain native status,
model and usage fields. Summing each final run once gives **446,693 input and
3,652 output tokens**, including **345,088 cache-read input tokens** and 2,344
reported reasoning tokens. Cache input is already included in input and is
not added again. Sixteen runs returned usage; the two deliberately cancelled
runs did not. This is reported usage, not a complete account bill or quota
balance. Duplicate stream frames and cumulative session views are excluded.

## Offline validation

The exact candidate passed 11 native login scenarios with a local backend
and a network guard; six native user-configuration cases; and both git and
non-git skill discovery controls. Configuration checks intentionally end at
a local backend error and establish loading and credential preservation,
not inference. Their selected observations are under `offline`.

The coherent upgraded tree passed `CI=1 pnpm run check`: 4,803 unit tests and
19 mock behavior cases, with one mock capability skip. PR checks additionally
validate the platform packages and ordinary installation paths.

Reproduction commands, after installing the locked dependencies:

```sh
node --import tsx experiments/cursor-login/probe.ts
node --import tsx experiments/cursor-user-configuration/probe.ts
OAR_TEST=cursor-skills node node_modules/vitest/vitest.mjs run sea-trial/vendor/cursor-skills.vendor.test.ts
node --import tsx experiments/live-contract.ts cursor --model gpt-5.4-nano --out /tmp/cursor-141-live
OAR_TEST_MODEL=gpt-5.4-nano node --import tsx experiments/cursor-disallowed-tools.ts
```

The last two commands contact the real provider and consume usage. Full raw
voyages and logs remain local with a file manifest; only the cited report facts
and native fields are committed. The selected evidence omits account data,
local paths and session/run identifiers.
