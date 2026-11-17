# DSH goals and remaining session-option boundaries

Measured on 2026-11-17, Linux x64, DSH 0.2.1-rc.5 (minimum) and
0.2.2-rc.1. Each probe used an isolated home and synthetic loopback provider;
no account login or paid request. This finishes the four option probes left
by the [launcher/schema report](README.md).

## Result

Enable `goals: true` through the native goal service. Keep the other three
options refused with specific findings. Hosts can control and observe native
goals without inventing a continuation loop or misreading a round budget as
a token budget. The adapter owns translation; DSH owns execution and state.

| Option/control | Observed native result | OAR decision |
|---|---|---|
| Goals create, edit, read, pause, resume, complete, clear | Structured durable state on both versions; another session stays empty | Expose `Session.goal` with opt-in |
| Goal pause while running | Native goal driver cancels the held turn; OAR observes `aborted` | Preserve the native turn ending |
| Goal clear while running | The held turn continues and completes after provider release | Clearing is not an OAR abort |
| Goal resume after process restart | Saved paused objective, native activation disarmed | Read native state; active set rearms it |
| Token budget | Native `maxGoalRounds` counts rounds, not tokens | Reject supplied token budgets before a native mutation; omit snapshot counters |
| Additional directories | Latest native filesystem allows an extra root; minimum ignores it | Remain refused: a roots-only overlay also replaces the existing policy mode |
| Exclude user configuration | Default dump removes the synthetic provider route and refuses `--patch` | Remain refused: no verified boot filter preserves provider/login/history |
| End turn processes on abort | Cancel leaves all three jobs alive; selected native kill removes one | Remain refused: registered Linux jobs are not evidence of complete per-turn process cleanup |

The [selected capture](remaining-selected.json) retains the native control
replies, goal changes, turn endings, filesystem outcomes and job result.
The [manifest](remaining-manifest.json) fingerprints full local captures;
local directory names and unrelated default configuration are not published.

## Goals

The probe calls `ctx.get("goals")` through an experiment-only bridge command,
with the goal driver disabled for deterministic mutation and cross-session
controls. The production bridge calls the same `get`, `create`, `edit`,
`pause`, `resume`, `complete` and `clear` methods. The native driver stays
unchanged in production. A separate vendor test enables it and holds a real
local-provider stream to test pause and clear independently.

Native `goal/change` version 1 carries operation, goal, rounds and timestamps;
clear has a tombstone. Explicit reads carry the actual service snapshot or
null. Both become `goal_changed` at their stream position. Milliseconds
become seconds; `maxGoalRounds`, `roundsStarted`, revision and activation
remain raw, with no invented token budget or usage. Unknown phases remain
visible. Setting blocked is refused because the native call requires a
structured reason not present in the shared setter.

The vendor lifecycle verifies paused persistence, clear/empty idempotence,
no native frame or mutation on a rejected token budget, and omission of the
control member when resume omits opt-in. Native continuation begins without
a host prompt. Host pause invokes native cancellation; clear does not. This
is a runtime difference, explicitly documented in the [shared spec](../../docs/spec/goals.md).

## Directory and configuration limits

The directory probe calls the actual native filesystem with the resolved
sandbox policy. With workspace-write and no extras, primary writes succeed
and an extra path is denied. With an extra root on 0.2.2-rc.1, both succeed;
0.2.1-rc.5 ignores the extra and denies it. Read-only denies both on both
versions. A new process without the override denies the extra again.

A second overlay containing only `additionalWritableRoots` resets the prior
workspace-write mode to read-only. Native Cordis patch composition replaces
the whole `config` value. An attempted public integration reproduced this
through the model's real `write` tool: `FS_SANDBOX_DENIED` under read-only,
with a completed turn containing a failed tool. That integration was
withdrawn. Setting a guessed mode would discard native configuration; a
future integration must preserve and confirm the effective policy.

The negative directory control originally lived under the OS temporary
root, which workspace-write already allows. That fixture was corrected to
use a path outside it; the initial failure is not a product defect. The
minimum-version denial was retained and made an explicit expected boundary.

Configuration probes use native `--dump-config`, `--dump-default-config` and
the latter with `--patch`. Only the ordinary composed dump retains the
isolated provider route. The flags do not establish a filtered boot that
keeps authentication and history while excluding instructions and plugins.
No real credentials or default provider requests were used.

## Abort-job limit

Three native background bash jobs are held: another session's job, an older
completed turn's job, and the current held turn's job. Native cancel ends the
current turn but all three shell PIDs remain alive. Owner-scoped `jobs.kill`
and `jobs.wait` on the selected job report killed; its shell is gone while
the other two remain. The same session accepts `AFTER_CLEANUP` through its
native inbox. Both versions passed this Linux control.

This proves a useful job service, not an inventory of every descendant a
turn might start. Non-job processes, child cleanup across platforms and
complete per-turn attribution remain unverified. OAR does not promise
`endTurnProcessesOnAbort` from this sample. Earlier fixture failures (PID
file startup timing, a request-ID field collision and a completion-notice
turn racing the next prompt) were corrected without changing product limits.

## Validation

Both pinned versions passed all 34 DSH vendor cases on Linux. The latest
version passed all 18 applicable public behavior cases; account usage is
absent and its case skips. Goal projection tests cover timestamp units,
unknown phases/versions and absence versus an invalid set reply.

## Reproduction and sources

Set `OAR_DSH_BIN` to one pinned executable, then run from the repository root:

```sh
pnpm tsx experiments/dsh-option-boundaries/probe-goals.ts
pnpm tsx experiments/dsh-option-boundaries/probe-directories.ts
pnpm tsx experiments/dsh-option-boundaries/probe-user-config.ts
pnpm tsx experiments/dsh-option-boundaries/probe-abort-jobs.ts
OAR_TEST=dsh-aimock pnpm exec vitest run sea-trial/vendor/dsh-goals.vendor.test.ts
OAR_TEST=dsh-aimock pnpm sea-trial
CI=1 pnpm run check
```

Scripts accept an output path as the first argument. For the minimum binary,
use `probe-directories.ts oar-trial-run/dsh-directories.json unsupported`;
this asserts that even the positive extra-root control is denied. The jobs
probe requires Linux. Public goal regressions run on every DSH vendor matrix
platform; these local measurements alone establish Linux behavior.

Pinned native trees are [0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db)
and [0.2.1-rc.5](https://github.com/deepseek-ai/deepseek-harness/tree/b830ec950faba0a46dda564be3e2d854afed94f1).
Relevant installed packages: `dsh-goal` (durable service and snapshot),
`dsh-goal-round-driver` (external pause cancels), `dsh-sandbox-policy`
(additional roots), `cordis-plugin-include` (whole-config patch replacement),
`dsh-jobs` (owner-scoped kill/wait), and the CLI's `args.ts` (dump flags).
No adapter imports these packages; production accesses services exposed by
the installed native plugin context.
