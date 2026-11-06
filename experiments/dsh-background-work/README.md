# Runtime version check: 2026-11-06

## Root completion is not session completion

Issue [#667](https://github.com/botiverse/oar/issues/667) asks whether a DSH host
can release its application context when the root turn ends. It cannot infer
that from root status alone. A child or shell command can remain active, then
cause a new root turn which calls another tool without any new host prompt.

`probe.ts` holds a real subagent's provider reply or a real background shell
behind a file gate. It waits for the first root completion before releasing
the work. The native completion notice then drives a scripted `pwd` call and
a second root completion. Both DSH 0.2.1-rc.5 and 0.2.2-rc.1 passed on Linux
x64, Node 24.19.0, with loopback providers and synthetic credentials. No real
account was used. The CI pin remains 0.2.1-rc.5.

| Flow | At first root completion on base `5a6408b8` | With job projection | After release |
|---|---|---|---|
| DSH subagent, both versions | Idle root, running agent task | Same | Child completes; native follow-up calls a tool and completes |
| DSH background bash, both versions | Idle root, empty task list | Idle root, running shell task | Shell settles; native follow-up calls a tool and completes |

All four DSH executions on the base and all four with the projection recorded
one host prompt and two root endings. `results.json` retains their summaries,
boundary snapshots and selected native records. Earlier setup attempts are
listed there separately: a wrong unsubscribe call failed cleanup, and a
non-UUID input id was refused before execution; neither counts as a passing run.

## Existing facts and the missing mapping

DSH already emits durable `job/registered` and `job/settled` records. OAR's bridge
already forwards them unchanged. The fix projects existing `task_started` and
`task_ended` events; it adds no event kind, capability, option or bridge method.

- Task identity is `jobId`, session identity is the native owner. Copied history
  does not transfer a live job to a different session.
- `bash` and `pwsh` producers map to `shell`; others retain their `nativeType`
  with type `other`. The native label and exact `toolCall.callId` are retained.
- Native `completed`/`failed` map directly and `killed` maps to `stopped`.
  Unknown outcomes stay raw. The terminal mappings and copied-owner controls
  are unit-tested; the live shell probe observes `completed` only.
- Both foreground and background jobs register. The durable event does not
  report a background flag, so none is invented. A native settlement, including
  teardown with `producerReported: false`, does not certify OS process cleanup.

The shell tool result and the root turn ending do not close the job. Only its
own native settlement closes the task. Removing the new projection makes both
the focused unit tests and real background-shell regression fail.

## How a host can use it

At a root `turn_ended`, inspect `tasksOf(records, rootSessionId).value` and retain
the live session and application context while reported tasks are `pending`,
`running` or `paused`. DSH's default shell completion delivery is `wakeup`:
an uncollected result reaches a busy owner's next step or opens an idle owner's
next turn. Subagents also wake an idle parent. A final `task_ended` can therefore
arrive before the new root turn starts. For these flows, observe the subsequent
root completion and re-check tasks before releasing the context.

There is no claim of a global quiescence barrier. `tool-jobs` can be configured
with `quiet` delivery or a wake limit, a result can already be collected, and
plugins can own work outside these records. An empty task list alone does not
promise that no future event will arrive.

The new turn's `turn_active` can contain a generated native input id; it need
not match any host request. The original `user/message.data.source.kind`
identifies `tool-jobs` or `subagent-settled`. OAR does not turn that notice into
a host user message. The probe asserts one host prompt and a tool call in the
native follow-up, so attribution cannot rely on a new host prompt.

## Claude and Codex controls

`compare.ts` ran Claude 2.1.318 and Codex 0.167.0 on Linux with local providers.
Each first root turn finished while a child reply or shell gate was held, then
the probe released it and observed five seconds. This bounded observation is
not proof about every future native event.

| Control | First root end | Within five seconds of release |
|---|---|---|
| Claude background Bash | Running shell task | Task completed; second root turn completed |
| Claude background Agent | Running agent task | Task completed; second root turn completed |
| Codex spawned child | Running agent task | Task completed; no second root turn observed |
| Codex yielded `exec_command` | No task row | Late command result; no second root turn observed |

The Codex shell control also exposed an existing status-fold discrepancy: its
late `item/completed` carries the first turn's id and a `tool_call_ended`, after
`turn/completed`, but status becomes `running`/`waiting_model` again. There is
no new `turn/started` or provider request. The selected records are retained;
this DSH change does not fix or generalize that behavior. Codex command items
are not currently task rows, so `tasksOf` cannot be advertised as complete
background-shell coverage for every runtime.

## Reproduction and validation

From the repository root, with the desired real CLI on each explicit path:

```sh
OAR_DSH_BIN=/path/to/dsh OAR_TEST=dsh-aimock pnpm tsx experiments/dsh-background-work/probe.ts /tmp/dsh-background-results
OAR_CLAUDE_BIN=/path/to/claude OAR_CODEX_BIN=/path/to/codex pnpm tsx experiments/dsh-background-work/compare.ts /tmp/background-controls
OAR_DSH_BIN=/path/to/dsh OAR_TEST=dsh-aimock pnpm vitest run sea-trial/vendor/dsh-background.vendor.test.ts
pnpm vitest run tests/dsh/jobs.test.ts
```

The manual shell gates are POSIX-only. The vendor regression uses Bash or
PowerShell according to the host platform and enters the existing DSH vendor
suite. It passed on all three CI platforms at `c95a8e69` on November 6 with the
DSH 0.2.1-rc.5 pin and local providers:

| Platform | Vendor tests passed | Behavior cases passed | Background-shell regression |
|---|---:|---:|---|
| [Linux](https://github.com/botiverse/oar/actions/runs/42236627645/job/127955817203) | 23 | 18 | Passed |
| [macOS](https://github.com/botiverse/oar/actions/runs/42236627645/job/127955817259) | 23 | 18 | Passed |
| [Windows](https://github.com/botiverse/oar/actions/runs/42236627645/job/127955817391) | 22 | 18 | Passed |

Every platform skipped the unsupported account-usage behavior case. Windows
also skipped the existing POSIX-only mid-turn process-kill vendor case; it ran
the new background-shell case. No deadlines or assertions were relaxed. The
manual subagent and Claude/Codex comparisons above remain Linux-only. Both
specified DSH versions passed all 23 vendor tests locally on Linux.

See `validation.json` for the completed checks. Raw traces are local
artifacts; the committed selection excludes provider headers and temporary
absolute paths.
