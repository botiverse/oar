# Codex goal boundaries: 2026-10-29

Codex 0.165.0 on Linux exposes native structured goals. Enabling the feature
changes the model's tools even before an objective exists, so OAR exposes
`Session.goal` only when the host opens with `goals: true`. The host choice
is explicit; continuation and the goal's lifecycle remain native.

The [probe](codex-goal-boundaries.ts) uses the real app-server with a local
scripted provider and temporary configuration. No account or model quota is
used. [Selected observations](codex-goal-boundaries-2026-10-29.json) omit
configuration and full provider payloads; the probe retains the complete
local trace in its requested output directory.

| Boundary | Observed result |
|---|---|
| Enabled with no objective | Provider request adds `get_goal`, `create_goal`, `update_goal`; goal read returns null. |
| Disabled feature | `thread/goal/get` rejects with `goals feature is disabled`. |
| Ephemeral thread | `thread/goal/set` rejects with `ephemeral thread does not support goals`. |
| Invalid budget update | Negative budget is rejected; the following read exactly matches the previously saved paused goal. |
| Resume in a fresh process | `thread/goal/updated` reports the saved objective and paused status. |
| Pause during a running turn | Native set returns paused before any turn completion; the current turn then completes normally. No new turn was observed in the following 500 ms. |
| Clear | Native response confirms removal; subsequent state is absent. |

The OAR [native regression](../sea-trial/vendor/codex-goals.vendor.test.ts)
checks the mapped controls, ordinary turn completion leaving a paused goal
paused, resume, repeated clear, automatic continuation without another host
prompt, native completion, budget exhaustion, and pause during an active
turn. The [unit regression](../tests/codex/codex-goals.test.ts) covers
omitted/false opt-in, a conflicting launch override, unsupported values
before send, reply Frame/notification wire order, identical serialized replay,
child attribution, unknown status words, missing fields, native refusals,
malformed replies, process death and credential redaction.

## Source evidence

All source references are pinned to Codex
[`360319d8`](https://github.com/openai/codex/tree/360319d8dee62d87e2d59fc0c21805d79519cfed),
the source used for 0.165.0:

- [Goal extension](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/ext/goal/src/extension.rs)
  registers the three model tools when `tools_visible` is true; the
  [runtime check](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/ext/goal/src/runtime.rs)
  depends on feature enablement, not an existing objective. [src]
- [RPC processor](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server/src/request_processors/thread_goal_processor.rs)
  checks feature enablement and requires a materialized thread. It writes
  the reply before ordered notifications, then applies runtime effects. [src]
- [Protocol](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
  defines the six native statuses, counters, nullable token budget and
  explicit user mutation origin. OAR preserves unknown read statuses for
  future native versions and refuses unknown set values. [src]

## Failed runs and fixture corrections

The first native-test invocation named a nonexistent Vitest config and
failed before running a case. The next invocation passed the lifecycle case
and exposed two fixture mistakes. The continuation objective itself
contained the marker used to recognize a completed work round, so it skipped
that round and produced two turn endings instead of three. The pause case
used an 1800 ms delay per streamed data block, exceeding its ten-second
observation window. The corrected fixture keeps the marker out of the
objective, uses disjoint response predicates, and applies 1800 ms only to
the first block followed by fast streaming. The original turn-count and
pause assertions and their deadlines remain. The three cases then passed.
The budget case was added separately and passed: budget 1 reported native
`budgetLimited` with 60 tokens used, without another OAR prompt.

A unit fixture for malformed replies originally emitted a valid subsequent
goal notification, contradicting its own no-observation assertion. It now
emits only the intended malformed reply. Original failure logs are retained
locally; no adapter retry or assertion was relaxed.

```sh
OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/codex-goal-boundaries.ts /tmp/goal-boundaries
CI=1 OAR_TEST=codex-aimock OAR_CODEX_BIN=/absolute/codex pnpm exec vitest run sea-trial/vendor/codex-goals.vendor.test.ts
```

For native autonomous completion and budget probes before the OAR mapping,
see the [October 28 report](native-goals-2026-10-28.md). The public contract
is [native goals](../docs/spec/goals.md).
