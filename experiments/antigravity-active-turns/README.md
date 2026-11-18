# Antigravity unsolicited activity and native lifecycle evidence

2026-11-18. Linux x64, Antigravity 1.5.10 and 1.5.11, synthetic local provider only.

## Result

Antigravity 1.5.10 and 1.5.11 send root tool completion and model text after the initial ACP prompt has returned `end_turn`, without another ACP turn end. Before this correction, OAR folded that text into a running status and an open view turn, while its ACP controller had no active turn and rejected abort with `no_active_turn`.

The native summary database exposes useful session state, but it does not reliably retain every short run. A reader started immediately on the first unsolicited update, then polled every 250 ms, missed the not-idle state in all six short controls. Opening a turn on content and waiting for a database transition would preserve the original indefinite-running problem.

The shared fold now retains such content as explicit outside-turn activity,
keeps status idle with activity timestamps, and does not open a view turn.
The database adoption option remains experimental: it needs reliable outcome
classification before it can emit a native turn end. The public rule is in
[record-stream.md](../../docs/spec/record-stream.md#the-rules).

## Method and boundaries

These are Linux x64 native-binary controls against isolated homes and a scripted local Gemini API provider, using `gemini-3.8-flash`. No real account, login, or paid model request was used. The native command first launches `sleep N; echo FINISHED` with `WaitMsBeforeAsync: 500`, answers STARTED, then resumes its own model work after the background command ends.

The direct ACP capture records all incoming messages and requests. A separate read-only SQLite observer records native table changes. The new reader starts at the first root content/tool update after the prompt response, excluding title, configuration and usage metadata. For these controls that trigger is the late completion of the original command. This deliberately tests the earliest possible read, before the subsequent model text. It is an experimental trigger, not a proposal to make all late tool completions turn starts.

The native process uses `--process-per-session`. This work does not establish Windows/macOS SQLite behavior, shared-process behavior, a real-service latency distribution, or arbitrary-version compatibility.

## ACP evidence

Both versions returned an initial `end_turn`, then a late `tool_call_update` and `agent_message_chunk`, with no second prompt request and no unsolicited completion response. `session/list` supplies identity, title and updated time but no active-state field. `session/state` returns method-not-found. `session/resume` and `session/load` return session/model/configuration data; load replays history, without a native end for the unsolicited run. Initialize metadata supplied no additional lifecycle channel.

Sources retained locally: `task298-native-queries-1510/capture.json`, `task298-native-queries-1511/capture.json`, and `task298-oar-status-abort-1511.json`. The latter records OAR running/responding followed by abort rejected as `no_active_turn` after the unsolicited text.

## Database meaning and ordering

The candidate is `.gemini/antigravity-cli/conversation_summaries.db`, beside `conversations/`. Its `conversation_summaries` table has plain `conversation_id`, `status`, `not_fully_idle`, `step_count` and `last_modified_time` columns. Reading these fields requires no protobuf decoding.

Observed states:

| Native state | Meaning supported by these controls |
| --- | --- |
| `CASCADE_RUN_STATUS_IDLE`, `not_fully_idle = 1` | The foreground loop is idle while background work remains. This is not a completed session. |
| `CASCADE_RUN_STATUS_RUNNING`, `not_fully_idle = 1` | The unsolicited model call is active. |
| `CASCADE_RUN_STATUS_IDLE`, `not_fully_idle = 0` | Native session is fully idle. |

The rows became visible at roughly one-second intervals in these samples. This is an observation, not a guaranteed flush interval. In the delayed-model controls, `last_modified_time` remained unchanged across IDLE/busy to RUNNING/busy; it is not a row-write clock. `step_count` rose when work completed. ACP carried no matching run id or step count. Thus the row is session-wide state with persistence lag, not a precisely correlated per-run terminal record.

The per-conversation database's completed command/model steps do not by themselves establish that the whole run has ended. Cancelled command steps have status 6 in the captured controls; normal completed commands have status 3.

## Transition controls

The first read was immediate, followed by 250 ms polling. Both native versions had the same results. Exact timestamps, changed rows and root updates are in [controls.json](controls.json).

| Control | Runs per version | Busy observed after activity | Explicit RUNNING observed | Later fully-idle transition |
| --- | ---: | ---: | ---: | ---: |
| 0.7 s command, immediate model reply | 3 | 0/3 | 0/3 | 0/3 |
| 4 s command, immediate model reply | 1 | 1/1 | 0/1 | 1/1 |
| 4 s command, model reply delayed 4 s | 1 | 1/1 | 1/1 | 1/1 |
| 0.7 s command, cancel after completion | 1 | 0/1 | 0/1 | 0/1 before the later health prompt |

For the six short controls, the first read found no session row yet. The first visible row was already fully idle. This was not a slow reader: the initial read completed in about 0.6 to 0.8 ms. The late activity began at 1.28 to 1.34 s after probe start; the first visible idle row was read at 1.53 to 1.59 s. Polling faster cannot recover a native state that was never persisted.

For both normal 4 s controls, the reader saw four busy samples and then fully idle about one second after adoption. For both delayed-model controls, it saw 20 busy samples, including 16 RUNNING samples, then fully idle. A finite control set does not guarantee capture for all longer runs or prove per-run ordering under overlapping native work.

## Cancellation and reuse

In one active-command control per version, `session/cancel` was sent after Antigravity spontaneously started a second `sleep 20` command. The tool became failed, its native database step became cancelled, and the summary changed to fully idle roughly 0.7 s later. A subsequent prompt on that same session returned normal text and `end_turn`. Cancel itself is a notification and produced no response or unsolicited ACP end. Selected evidence: [cancel-controls.json](cancel-controls.json).

In one short-run late-cancel control per version, cancel was sent after the run had already completed and its busy state had been missed. During the following 2.5 s there were no agent frames and no new busy-to-idle transition. The subsequent health prompt still worked. Therefore native cancellation cannot supply a missing lifecycle acknowledgement by itself.

The existing isolated ACP abort fallback in `shared/acp/turns.ts` waits 10 s by default, then kills the owned runtime if the active operation has not settled. The observed process exit closes the turn. This is not a fabricated native end and does not preserve that process for another prompt. The normal active-cancel controls preserved the session because native work actually settled; the fallback was not used in those direct-native probes. An adopted database-backed turn must bind the same controller used by prompt/abort and clear its fallback only on observed settlement.

## Read cost and version boundary

On these isolated Linux databases, opening a read-only connection, preparing the five-column query and reading once cost 0.627 ms on 1.5.10 and 0.760 ms on 1.5.11. Across 1,000 reads on each open connection, medians were 0.0035 ms and maxima 0.066/0.080 ms. These are local microbenchmarks, not cross-platform guarantees. A reader starts no native process.

A proposed reader should inspect only the known session row in the selected state directory, use read-only access, and retain every observed row that drives an event as a native frame. Gate it to explicitly verified versions and schemas. Missing files/rows, busy errors, unexpected columns/types/states or unsupported versions mean no observation, never fully idle. Start inspection only after unsolicited root activity; poll while seeking a first busy observation or tracking an adopted turn, then stop after observed fully idle. Polling cadence is not a completion timer.

Two issues remain before enabling this path: proving ordering beyond these serial controls, and preserving outcome honesty. Fully idle establishes no active work; the summary fields alone do not distinguish successful completion from every failure mode. The first implementation can ship the general activity correction separately while these database boundaries are resolved.

## New prompt during native own work

The 1.5.11 [control](prompt-during-activity.ts) let a 4 s background command
finish, then made the unsolicited model response start a second 8 s command.
OAR sent a new prompt while that command was still running. The subsequent
native model request contained the exact new instruction, and the resulting
reply included `NEW_INSTRUCTION_FOLLOWED` before the prompted `end_turn`.
The pre-prompt content stayed in `ViewActivity`; the new reply was in the
prompted turn. The existing tool's later result updated its original activity
entry by call id. [Selected records](prompt-during-activity.json) retain the
observed order and the native tool start, text and terminal response.
This is one local-provider control, not a guarantee about every overlapping
native scheduler path. An initial attempt omitted required `toolSummary`
arguments and was rejected before any command ran; it is excluded here.

## Reproduce

Use verified binaries at the versions above. Both scripts create an isolated
home and local scripted provider; they do not use a real account.

```sh
pnpm tsx experiments/antigravity-active-turns/prompt-during-activity.ts /absolute/path/to/agy-1.5.11 /tmp/prompt-activity.json
TASK298_DATABASE=1 pnpm tsx experiments/antigravity-active-turns/native.ts /absolute/path/to/agy-1.5.11 1.5.11 normal /tmp/native-activity
TASK298_DATABASE=1 TASK298_COMMAND_SECONDS=0.7 pnpm tsx experiments/antigravity-active-turns/native.ts /absolute/path/to/agy-1.5.10 1.5.10 normal /tmp/native-short
```

Native modes `slow`, `cancel`, `late-cancel` and `queries` reproduce the
other boundaries. The SQLite observer is experiment-only and uses read-only
connections. No product database reader is added.

## Consumer and regression checks

The view union addition requires an activity branch in exhaustive consumers.
The in-repo Pi Durable demo renders it. A read-only check of Ferry main
`1531ed3f` found view consumption in `packages/core/src/timeline.ts` and
input/turn/notice switches in `apps/web/src/features/session/Transcript.tsx`
and `packages/core/src/render-text.ts`; its next upgrade needs activity
rendering. Raft's maintainer confirmed its daemon does not consume this view.

Controls cover outside content followed by all nine mapped native starts,
new prompts, sliced streams versus checkpoints, child attribution, late tool
updates, process exit and the recorded OpenCode 2.3.0 own-reply case. The
16-backend behavior run passed with CI-pinned binaries.

## Retention

Full captures, observer output and synthetic conversation databases remain local under `artifacts/task298-*`, indexed by `artifacts/task298-raw-manifest.json`. This directory includes only the selected evidence cited above, plus the reproducible probes.
