# Antigravity background disk scan and cancellation

On 2026-11-17, agy 1.5.9 through OAR on Linux did **not** reproduce a
reported desktop session that remained busy for 18 minutes while scanning
the home directory. A controlled slow `du` did reproduce a related boundary:
`end_turn` arrives while the native background command is still alive, and
cancelling an active turn does not necessarily terminate that command.

This is a native-behavior observation, not an OAR adapter fix. OAR preserved
the native turn end and tool updates it received. It did not manufacture a
tool completion when the command left the foreground.

## Setup and limits

- OAR base: `bcaf599b16c96ab4d050c36c4c5c33a7378b9aa1`.
- Native binary: Antigravity CLI 1.5.9, Linux x64; SHA-256
  `39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43`.
- Fresh temporary HOME and native state, local scripted Gemini provider,
  synthetic API key. No real account, remote model request or user files.
- Actual `df`, `du`, `sort` and `head`, with 150 generated files in five
  directories, including a hidden one. The command only reads these files.
- An `LD_PRELOAD` library delays each directory-entry read in **du only** by
  60 ms. This makes the scan last about ten seconds without traversing a
  real home or creating millions of files. It also records the actual PID.
- A native launcher records the agy PID. `/proc` captures PID, start time,
  process group and state. A reused PID is not accepted as the same process.
- Each prompt phase has a 120-second bound after session creation. All five runs finished in under
  14 seconds and left no members of the observed native or shell process
  groups after `dispose()`. The emergency kill path was not used.

The provider deliberately chooses `run_command` and its wait threshold;
these runs test native execution and ACP reporting, not a real model's
choice of tools or decision to keep waiting. The reported desktop used
macOS and a different model. Neither that desktop UI nor a kernel-level
uninterruptible filesystem wait was reproduced here. This is not evidence
that the original report is fixed or impossible.

## Observations

Times are milliseconds from each probe's start. The published
[observations](observations.json) preserve native stop reasons and tool
statuses alongside OAR projections, state samples and process groups.

| Case | Native/OAR turn | Actual command | Next prompt |
|---|---|---|---|
| Natural completion, 500 ms foreground wait | `end_turn` / `completed` at 1415; OAR becomes `idle` | `du` alive after turn end, first observed gone at 10593 | Accepted at 13097; completed at 13145 |
| Abort after turn end | OAR rejects with `no_active_turn` at 1644 | `du` and shell pipeline still present before disposal | Accepted and completed while the previous scan remains alive |
| Abort during model request after command backgrounds | Native `cancelled` / OAR `aborted` at 1643 | `du` still alive at 3649, over two seconds after the abort; shell, sort and head also present before disposal | Accepted and completed |
| Abort while command remains foreground, 30000 ms wait | Native `cancelled` / OAR `aborted` at 1142; native tool update `failed` | `du` already gone at the first post-abort sample, 1148; shell group absent before disposal | Accepted and completed |
| Dispose while command backgrounds | Root already completed at 1530 | Shell, du, sort and head present before disposal at 1627; all observed groups empty at 1956 | Not attempted after disposal |

In the natural-completion case, `tool_call` at 890 reported
`status: in_progress`, projected as `tool_call_started`. There was no
periodic progress update. The scan finished and the provider received a
background continuation at 10556, but no tool completion or subsequent text
arrived through ACP during the following roughly 2.5 seconds. OAR stayed
idle. At 13097 a new prompt was accepted; at 13102 native ACP delivered the
previous tool's `completed` update with exit code zero, followed by its
background text. OAR projected both. The new prompt then returned
`LATER_ACCEPTED` and its own completed turn.

The delayed events were observed immediately after the next prompt in this
run; this does not prove that submitting a prompt is the only possible
native flush trigger. The earlier [native gap experiment](../antigravity-native-gaps-2026-11-15/README.md)
also observed missing background completion during a longer, 12-second idle
window. Its related upstream report is
[antigravity-cli#1461](https://github.com/google-antigravity/antigravity-cli/issues/1461).

The active-abort case holds the provider's second response to keep the
root turn active after backgrounding. The foreground control changes only
`WaitMsBeforeAsync` to 30000 and cancels after verifying that `du` has
started. This distinguishes turn cancellation from background-process
termination. `Session.status().idle` describes the root turn, not a claim
that every native task has stopped. A native background command can remain
live without an active root turn to abort.

## Status replay and a possible future cleanup option

The live late completion arrived after the next prompt had already been
accepted. At that event's cursor, `statusOf()` was `running` with
`phase: waiting_model`; the probe asserts this rather than claiming that
the live session was idle. To test the separate rule that a tool completion
cannot reopen an idle turn, it takes the records through the first turn
end, appends only the captured late tool frame, and asserts `idle`. This
replay deliberately omits the next prompt and the background text; it is a
projection control, not a claim about the live transport order. Both
states are retained as `late-tool-status` in the evidence. Idle is also
asserted after the first and the subsequent turn ends.

All five cases recorded zero `toApp` ACP `terminal/*` requests. In the
background cancellation/disposal controls, the process parents were native
agy, its native worker, bash, then du/sort/head. The shell therefore ran
under agy, not in an ACP terminal hosted by OAR. The complete case's command
had already exited by the final group observation.

A future `endTurnProcessesOnAbort` implementation could not simply reuse
Grok's known hosted-terminal handles. It would need a measured native
command-termination interface or reliable per-turn process ownership and
cross-platform cleanup, including commands intentionally spanning turns.
These probes establish neither that interface nor that ownership mechanism.
No such option or adapter behavior is added here.

## Reproduce

Requires Linux, Node 24+, pnpm, Python 3, GCC/glibc, and the 1.5.9 binary.
From the repository root, after `pnpm install --frozen-lockfile`:

```sh
pnpm tsx experiments/antigravity-disk-scan/probe.ts /absolute/path/to/antigravity complete /tmp/agy-complete.json
pnpm tsx experiments/antigravity-disk-scan/probe.ts /absolute/path/to/antigravity idle-abort /tmp/agy-idle-abort.json
pnpm tsx experiments/antigravity-disk-scan/probe.ts /absolute/path/to/antigravity active-abort /tmp/agy-active-abort.json
pnpm tsx experiments/antigravity-disk-scan/probe.ts /absolute/path/to/antigravity foreground-abort /tmp/agy-foreground-abort.json
pnpm tsx experiments/antigravity-disk-scan/probe.ts /absolute/path/to/antigravity dispose /tmp/agy-dispose.json
python3 experiments/antigravity-disk-scan/select.py /tmp/agy- /tmp/observations.json
```

The raw outputs contain synthetic prompts, native frames and local temporary
paths. `select.py` omits provider bodies and command arguments, retains relevant
native/OAR event pairs, and compresses repeated polling to state changes.
It includes each input's SHA-256 so an investigator can compare retained raw
files. The binary's hash above identifies the measured executable; the
probe checks its version and refuses another version until reassessed.

Validation: all five native modes passed with status/terminal assertions.
An initial observation-only run and a repeat agreed on cancellation and
cleanup. A later replay check first failed because the probe retained the
live records array rather than a snapshot; copying that array fixed the
probe, with the failed raw run retained outside the published evidence.
