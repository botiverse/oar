# DSH settlement notifications

Runtime version check: 2026-11-06

**The requested durable decision per settlement is missing in both tested versions.** DSH already records which messages enter or leave an inbox, so a host can identify a notification that is currently pending. That does not provide an explicit negative decision when no notification is queued, or a recorded wake decision tied to every settled job. OAR preserves these native facts and does not infer a new event.

This is narrower than saying that DSH records nothing useful. Quiet delivery and exhausted wake budgets do record pending notices. Normal subagent delivery also happens before its `subagent/end` event, unlike job delivery. These differences matter to the host's interpretation.

The request being checked is [issue #667's follow-up](https://github.com/botiverse/oar/issues/667#issuecomment-6693576349). The findings below come from source inspection and controlled native execution, not from accepting that comment as evidence.

## What ran

Linux x64, OAR base `576e66726d931501d6a21de3c9d610e9aa1d2488`, real DSH **0.2.2-rc.1** and **0.2.1-rc.5**, each with its own temporary home and a scripted loopback provider. No account or remote inference was used. All eight cases passed on both versions. The set was repeated with observational calls to the existing native `Agent.whenIdle()` method; all sixteen combinations passed again. The final checked-in probe, with JSON shape validation, also passed all sixteen combinations after rebasing to OAR `44dbc3fc`. Its native event order, notice outcomes and idle-wait observations matched the selected run; the host checkpoints' last observed status sometimes differed between `running` and `idle`.

The observer is an additional in-process plugin. It only reads native agent/inbox state, subscribes to native events, calls `whenIdle()`, and writes a separate diagnostic file. It changes no method, message, native event, or scheduling policy. Every observed root session event was also found in the decompressed durable session log after disposal. The first run without `whenIdle()` calls and the final run agree on notice counts and root turn counts.

[Selected evidence](selected.json) includes native sequence numbers, inbox sizes at event callbacks, the order of subagent delivery, native idle-wait results, and hashes of the retained raw files. The selection omits session IDs, temporary paths, and prompt context. [Source and installed-package hashes](source-manifest.json) identify the exact tagged source and native packages. Windows, macOS, remote providers, arbitrary plugins, and forced persistence failures were not tested here.

## Four job cases and a control

Both versions produced the same decisions in these cases. Counts below are taken before the explicit later host prompt.

| Case | Persistent records | Pending inbox after settlement | Subsequent root turn |
| --- | --- | --- | --- |
| Ordinary completion, `wakeup` | `job/settled`, notice insertion into `next-turn`, claim/removal, `user/message`, turn boundaries | Empty after the notice is consumed | One automatic turn |
| Model calls `job_kill` | Successful `tool/result`; `job/settled` with `status: killed`, `cause: kill` | Empty; no notice insertion | None during the 500 ms observation |
| `job_output(wait: true)` collects completion | `job/settled`; successful `tool/result` contains `JOB_1_DONE` and completed status | Empty; no notice insertion | None during the 500 ms observation |
| `completionDelivery: quiet` | `job/settled`; notice insertion into `next-step` | One message while agent is idle | None until the later host input |
| `maxConsecutiveWakes: 1`, second completion | First notice opens a turn; second `job/settled` inserts a notice into `next-step` | One message while agent is idle | No third turn until the later host input |

The waiting-read case is precise: the registry's **live** settled event had `awaited: true`, and the next provider request contained the completed tool result. It is not evidence that any earlier call to `job_output` suppresses a later completion. A timed-out read that still reports a running job does not establish that.

Quiet and exhausted-budget notices were consumed after an explicit `HOST_WAKE` prompt. Thus they are parked work, not a missing notification. Source inspection establishes the no-wake branch; the 500 ms samples alone do not prove that nothing can ever run later. The two versions also differ outside this assertion: rc.1 can inline output and withdraw a still-pending notice when `job_output` collects it. The older rc.5 source does not have that pending-notice map.

The original absence claim is correct for the skipped-notice branch, **not** for quiet or exhausted-budget delivery. There is still a job settlement and usually a tool result when a notice is skipped; what is absent is a separate recorded disposition saying that this settlement queued no notice. [Native delivery implementation: rc.1](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/jobs/tool-jobs/src/index.ts#L370), [rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/jobs/tool-jobs/src/index.ts#L273).

## The observable gap at job settlement

The ordinary wake case in both versions has this native root-log order:

```text
21  turn/end, turn 1
22  job/settled
23  agent/inbox/spliced: insert tool-jobs notice into next-turn
24  turn/start, turn 2
25  agent/inbox/spliced: claim/remove the notice
30  turn/end, turn 2
```

At the `job/settled` callback, the native agent is idle and both inbox lists are empty. The quiet case has the same empty inbox at sequence 22, then inserts into `next-step` at 23 and remains idle. Reading the inbox synchronously at the settlement therefore does not yet read the delivery decision. This ordering is also explicit in the registry: it appends the durable settlement, releases waiters, and then calls its live subscribers. [Registry source](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/jobs/jobs-local/src/index.ts#L603).

The persisted job record has `jobId`, owner, kind, label, time, outcome, cause, producer acknowledgement and tool-call identity. It has no notice ID, wake flag, delivery reason, or negative notification result. `awaited` exists on the in-process jobs event, not on the durable `job/settled` data. The model-kill set, wake counter and pending-delivery bookkeeping are plugin-local state. [Native job record and live event types](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/jobs/jobs/src/types.ts).

An inserted `tool-jobs` message has an ID and `source.kind`, but its source contains no structured job ID. The job ID is in rendered text. A host should not treat parsing that text as the missing typed association.

## Existing inbox facts are usable

The OAR bridge already preserves each native splice as a raw frame with `body.type: "session/event:agent/inbox/spliced"` and the original native event in `body.native`. No new interface is needed to inspect these facts:

- Maintain the native `next-turn` and `next-step` arrays by applying `start`, `removedCount` and `inserted` in sequence.
- Each inserted message has its own ID and source. A currently present `tool-jobs` or `subagent-settled` message is a pending native notification.
- Removal records account for the transition out of the inbox. Explicit cancellation carries `outcome: canceled`; claiming removes the message without that outcome. A later `user/message` shows entry into committed conversation context.

Inside the process, `agent.inbox.nextTurn` and `agent.inbox.nextStep` expose the same current native facts. `agent/inbox/inserted`, `claimed`, and `discarded` are live notifications following the durable splice; they are not separate durable per-settlement dispositions. [Inbox implementation](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/inbox.ts).

Neither the splice target nor an empty list certifies a future wake decision. `send` accepts its `wakeup` argument separately from the target; `steer` and `inject` both address `next-step`, with different wake behavior. The runtime's `turn/start.cause` is not used by this analysis. [Agent routing](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L170).

## Native `whenIdle()` observation, not a host contract

This native wait concerns current whole-agent activity, not a disposition for any particular message. It remains an experimental observation here, not an OAR interface or a dependency for deciding notification delivery. The probe called it at root turn end and at job settlement:

- After the first root end, it resolved while the held background job or child still had work to do. It did not wait for that external work.
- When called during ordinary job settlement, it followed the ensuing wake turn through its end in these runs.
- With quiet delivery or an exhausted budget, it resolved with one notice still parked in `nextStep`.

Following the wake in these runs does not establish ordering across arbitrary plugin subscribers. It does not produce the requested durable settlement-to-notice association or an explicit decision that no notice was queued. A host must not turn its fulfillment into a universal promise against later plugin work. [Native contract](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent/src/runtime-types.ts#L216).

## Subagents have different ordering

For a naturally completed child, both versions persisted the parent notice at native sequence 22, started root turn 2 at 23, and only then emitted the live `subagent/end`. At that end callback the parent was already running; the inbox could be empty because the new turn had claimed the notice. The notice's `source.senderSessionId` provides a structured association to the child.

The same happened with the jobs plugin configured `quiet`: that option does not govern subagent delivery. When the model used `interrupt_agent`, the child ended `aborted`; a `subagent-settled` notice still entered the busy parent's `next-step` before `subagent/end`, and the existing root turn consumed it. The job-kill suppression rule does not apply to this control.

Source inspection confirms `notifySettlement` precedes the lifecycle end emission. It can skip an unannounced or caller-delivered activation, or a parent that no longer matches; during parent teardown it injects rather than wakes. A notification-delivery exception is logged, not turned into a durable negative decision. Normal tested subagent delivery is therefore directly observable before its end, but `subagent/end` alone is not a general notification receipt. [rc.1 manager](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/subagent/subagent/src/manager.ts#L1195), [rc.5 manager](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/subagent/subagent/src/manager.ts#L1174).

The reporter also mentioned a retirement-window case. The pinned [tool-jobs README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/jobs/tool-jobs/README.md#L176) does describe a notice stranded between the last inbox check and the idle transition. That specific timing was not reproduced here; it is a source/documentation finding only.

## OAR decision

OAR documents the native inbox facts and the limit above. It does not add a timer, infer a negative decision from silence, expose `whenIdle()`, or promise a follow-up turn for every `task_ended`. The requested durable job/child-to-notice decision, including the no-notice outcome, would need an upstream native record. That evidence would reopen the [design decision](../../docs/design/decisions.md#no-inferred-settlement-disposition-2026-11-06). This change adds documentation and experiments only.

## Reproduce

Install the checkout's dependencies. The probe uses POSIX shell file gates and was run on Linux. Point `OAR_DSH_BIN` at the selected native CLI, with the complete matching DSH dependency set. Run each version separately:

```sh
OAR_DSH_BIN=/absolute/path/to/dsh TMPDIR=/tmp pnpm exec tsx \
  experiments/dsh-settlement-notifications/probe.ts /absolute/output/path
```

An optional final argument selects one of `wake`, `kill`, `collected`, `quiet`, `budget`, `child`, `child-quiet`, or `child-interrupt`. The output contains observer JSONL, OAR records/provider requests, the decompressed durable log, and a case summary. All native processes and file gates are fixture-owned. Pass the complete output directories for rc.1 and rc.5, in that order, to the selector:

```sh
python3 experiments/dsh-settlement-notifications/select.py \
  /absolute/output/rc1 /absolute/output/rc5 > /absolute/output/selected.json
```

The selected checkpoint's native state is the last observer sample available at that host checkpoint. Event callback samples and `whenIdle` resolution samples are in-process reads at those exact callbacks. Raw files remain local; source/package hashes and selected non-identifying facts are included for review.
