# Native goals: 2026-10-28

This is research and an interface proposal, not a shipped OAR capability.
Codex 0.165.0 exposes structured goal controls and notifications through the
existing app-server. Claude 2.1.312 executes `/goal` through the existing
stream-json path, but that path did not expose a structured goal outcome.
A successful Claude turn must not become a goal-completed event.

The host decision this evidence supports is whether to offer native goal
controls and show a goal's state. Runtime adapters would own protocol mapping;
the runtime would own continuation, accounting and completion. The rerunnable
[probe](native-goals.ts) and [compact evidence](native-goals-2026-10-28.json)
are the continuation artifact. No account, login or external model was used.

## Reproduce

```sh
OAR_CODEX_BIN=/path/to/codex pnpm tsx experiments/native-goals.ts codex ./oar-trial-run/goals-codex
OAR_CLAUDE_BIN=/path/to/claude pnpm tsx experiments/native-goals.ts claude ./oar-trial-run/goals-claude
```

Each run creates temporary configuration and a local scripted provider. Codex
uses the existing app-server client, explicitly enabling `features.goals` and
experimental API access. Claude uses OAR's existing stream-json session launch.
The provider scripts the main reply and Claude's Stop evaluator, so these runs
verify native control flow, not an LLM's judgment about real task completion.
Raw requests, responses and notifications are written to the selected output
directory. CLI paths select the tested installation; no dependency is upgraded.

## Codex

| Surface | Observed behavior |
|---|---|
| `thread/goal/set` | Sets or updates objective, status and optional token budget. `origin: "user"` records the host-authorized origin. |
| `thread/goal/get` | Returns `{ goal }`, including native status, budget, usage, timestamps and thread identity. |
| `thread/goal/clear` | First call returned `cleared: true`; readback was `goal: null`; repeated clear returned `cleared: false`. |
| `thread/goal/updated` | Reports the native goal, thread and nullable turn identity. The probe received paused, active, complete and budgetLimited states. |
| `thread/goal/cleared` | Reports explicit removal; it does not mean completion. |

After one host-created seed turn, setting a paused goal started no further turn
in the 300 ms observation window. Activating it started a native turn; its
unfinished reply triggered another native turn without another `turn/start`
from the host. The scripted model called native `update_goal` with `complete`.
Readback then reported complete and 60 used tokens. That status is Codex's
report, not an independent verification of the objective.

A second goal with `tokenBudget: 1` received a model usage report of 40 input
plus 20 output tokens and became `budgetLimited`, with `tokensUsed: 60`.
The budget stops subsequent continuation after accounting; this sample proves
it is not a guarantee that no more than the requested token count can be used.
`timeUsedSeconds` is native accounting, not a supported wall-clock budget.

Pinned source is [Codex rust-v0.165.0, commit 360319d8](https://github.com/openai/codex/tree/360319d8dee62d87e2d59fc0c21805d79519cfed).
The [protocol definitions](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
also define blocked and usageLimited, which this probe did not trigger.
The [request processor](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server/src/request_processors/thread_goal_processor.rs)
requires goals to be enabled and a materialized thread with persistent state;
parent-owned subagent mutations have separate authorization rules. The
[goal extension](https://github.com/openai/codex/tree/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/ext/goal)
starts continuations for active idle threads. An unchanged objective preserves
accounting; replacing it resets accounting. An omitted budget preserves it,
null clears it, and a number must be positive. Pausing is a goal-state change;
it must not be advertised as cancellation of an already running turn. This
probe paused before activation and did not test an in-flight pause.

The official [goals walkthrough](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
and [app-server reference](https://learn.chatgpt.com/docs/app-server) explain
the supported native path. The pinned source and local run above establish
which details were checked for this version.

## Claude

The actual sequence was:

1. One host prompt, `/goal Reply with GOAL_FINISHED after WORK_ROUND_ONE`.
2. Main model replied `WORK_ROUND_ONE`.
3. Native Stop hook asked its evaluator, which returned `ok: false`.
4. Claude automatically made another main-model request and got `GOAL_FINISHED`.
5. The Stop evaluator returned `ok: true`, then the ordinary turn completed.

There were four provider requests: two main-model and two evaluator requests.
A subsequent `/goal` reported "No goal set" as text. `/goal clear` also reported
"No goal set". Neither proves why a previously set goal disappeared. No
`goal_status` or `active_goal` structure appeared in the captured stream-json
records; the ordinary result had success status.

The [official goal documentation](https://code.claude.com/docs/en/goal) describes
a condition checked by a Stop hook. Inspection of the shipped 2.1.312 Linux
executable confirms the noninteractive `/goal` handler, its Stop-hook evaluator,
and its internal state. Internal `goal_status` attachments are not a public
stream-json notification. In particular, the internal clear path can create a
`met: true` sentinel, so even that internal flag must not be treated as proof
of achievement. The probe publishes no vendor source excerpt.

The command supports setting a condition, text status and clearing. `pause`
is not a structured pause operation: it is parsed as a new condition. There
is no numeric token-budget control equivalent to Codex's in this path. Hook
restrictions can prevent goal setup, and a hook failure can remove a goal.
The local run did not exercise those failures or clearing a goal mid-flight.
A future public channel carrying goal outcome would need a fresh probe.

## Optional interface proposal

This proposal deliberately stays outside `docs/spec`: Cindy has not approved
an implementation or public API shape.

- An optional session goal controller would provide `set`, `read` and `clear`
  as recorded controls. A runtime without the whole capability has no
  controller. A generic dispatch helper returns a typed unsupported rejection
  before sending anything when the controller or requested option is absent.
- `set` accepts an objective and optional supported status/budget updates.
  It preserves native omitted/null semantics. A host may only claim pause,
  resume or budget support when the adapter has a native operation for it.
- A single `goal_changed` event carries `{ goal: GoalSnapshot | null }`.
  It is derived only from native goal notifications or native control replies.
  Null means observed removal; before any observation the state is unknown.
  Requests alone do not update the fold. Native status, token usage and budget
  remain runtime reports, and unreported fields remain absent.
- Goal updates retain native session/turn attribution and the existing record
  cursor. Native auto-started turns keep their own identities and records;
  OAR does not prompt again, poll a model, parse transcript text, or run a
  second continuation loop. A completed turn does not complete a goal.
- Codex can support this controller after feature-gate and failure-path tests.
  Claude currently cannot support the structured controller/event together.
  Its `/goal` remains an ordinary native command with its raw frames; generic
  structured goal requests must be refused instead of being translated into
  text and reported as if the intended state had taken effect.

Before implementation, decide the public names and refusal shape, then pin
native-disabled, ephemeral-thread, rejected-update, resume snapshot and
in-flight pause cases. The proposal does not add a new launch transport,
change the existing abort contract, or infer state from private history files.
