# Pi Durable task parking: 2026-10-23

Pi Durable 1.4.0 can park an unfinished task while OAR continues to observe
its run as running. This is native liveness information outside the
`watchEvents` conversation stream; OAR must not manufacture a terminal
outcome from it.

Run `pnpm tsx experiments/pi-durable-parked-task.ts`. The probe uses the
installed native SDK, JSONL storage in a temporary directory and its faux
provider. It starts five child processes in sequence and kills each with
`SIGKILL` once the provider is called, before any response or task-state
progress. Every restart reuses the same durable input id. It neither calls
`Harness.close()` in those children nor edits native task records. The next
Harness open uses the default restart limit, without overriding settings.

Observed on Linux x64 with Node 24.19.0, Pi AI, Durable and Chord 1.4.0:

| Surface | After the fifth interruption | After explicit host `retryTask` |
|---|---|---|
| `onReport` | `task_parked`, kind `pi.generation` | No second parked report |
| `inspect()` | One task blocked by `restart_limit`, `restarts: 5` | No unfinished tasks |
| `watchEvents` snapshot | Run still present | Run absent |
| OAR | Running; no `turn_ended` on adoption | Idle after the native run completes |
| Provider calls in the final process | 0 | 1 |

The probe asserts these facts and prints a compact JSON result. The host's
retry is a positive control: parking is not a lost conversation or a
completed run. Attaching OAR by itself does not bypass the native limit.

The first probe reached parking but its OAR attachment was refused because
the fixture introduced a different cwd while adopting an active run. The
fixture was corrected to save the same cwd from the start; the native
parking assertions were unchanged. The corrected probe passed.

This verifies the default limit for a generation interrupted before a
provider response, not every host extension, task phase or storage backend.
The native `HarnessSettings.restartLimit` contract excludes a normal close
and permits configuration, including `Infinity` to disable parking. Those
alternatives were not exercised here. No accounts, credentials or network
provider calls were used.
