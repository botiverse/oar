# Input ownership after interruption, 2026-10-08

An accepted steer is not necessarily read. This audit checks whether a
runtime retains that input after an abort, so a host can decide whether it
owns the input again. OAR only emits a discard event when native evidence
supports that decision; a turn end alone cannot establish it.

All executed conversations used native CLIs or the Pi SDK, temporary homes
and local scripted model providers with dummy keys. No real account or
model quota was used.

| Runtime | Evidence | Mapping |
| --- | --- | --- |
| Codex 0.161.0 | While `exec_command` was pending, `turn/steer` accepted the UUID. Interrupt ended the turn without its user-message echo. The next prompt's provider input did not contain the steer. | On interrupted root completion, drop accepted un-echoed steers for that turn, before `turn_ended`. |
| Claude 2.1.293 | `interrupt` returned `still_queued: [inputId]`. The next provider request contained that input. | Preserve input, no drop event. |
| Pi SDK 1.0.4 | The aborted tool settled; the next prompt's provider request contained the steer. | Preserve input, no drop event. |
| OpenCode 1.18.35 | A steer followed immediately by cancel remained in the next prompt's provider request. | Preserve input, no drop event. |
| Grok 1.0.46 | Immediate abort lost the replacement prompt's steer; abort after its first provider request retained it. Both reported `cancelled` / `MidTurnAbort`. | No reliable discard predicate yet; keep native facts and do not return already-read input by guessing. |
| Cursor SDK 1.0.36 | Installed SDK source returns undelivered steering as `revert_to_followup`; OAR accepts only `complete_delivered`. Adapter tests exercise cancellation before delivery. | Existing refusal handles ownership. Native backend abort race not executed. |

Kimi and Antigravity expose no `steer` member.

## Reproduce

```sh
pnpm tsx experiments/input-interruption.ts codex
pnpm tsx experiments/input-interruption.ts claude
pnpm tsx experiments/input-interruption.ts pi
pnpm tsx experiments/input-interruption.ts opencode
pnpm tsx experiments/input-interruption.ts grok
pnpm tsx experiments/input-interruption.ts grok after-read
```

Use the runtime's `OAR_*_BIN` override to pin a binary. Pi comes from the
lockfile. Runs write `oar-trial-run/input-interruption/<runtime>.json`, or
`grok-after-read.json`, with control responses, retained records, the view
at interruption and marker presence in each provider request. The marker
is ordinary probe input, not an adapter-injected correlation mechanism.
`after-read` waits for that marker at the local provider before aborting.
The next prompt checks retained conversation, not resume after process death.

The reusable fixture lives in
[`sea-trial/vendor/support/input-interruption.ts`](../sea-trial/vendor/support/input-interruption.ts).
The Codex vendor regression asserts the accepted steer, absence of its
echo, drop-before-end ordering, empty pending tray and absence from the
next provider request. Pure tests separately exclude echoed inputs, other
turns, children, queues and non-interrupted completion; view tests cover
exit, retry of the same input ID and turn ends with no discard evidence.

## Why the Codex rule is justified

At official source commit `ea27864f99f0b086cec2f9f0251b7190fb9844f1`,
[`abort_all_tasks`](https://github.com/openai/codex/blob/ea27864f99f0b086cec2f9f0251b7190fb9844f1/codex-rs/core/src/tasks/mod.rs#L549)
takes the active turn and clears its pending input. Codex's own
[`input_restore.rs`](https://github.com/openai/codex/blob/ea27864f99f0b086cec2f9f0251b7190fb9844f1/codex-rs/tui/src/chatwidget/input_restore.rs#L340)
restores unacknowledged steers when interrupted completion reaches the UI,
because the server has discarded them. OAR follows that same scope, with
acceptance recorded synchronously from the RPC reply and native user-message
echoes tracked by client ID and turn ID. It does not apply the rule to the
independently durable queue. Source and native probe agree.

## Retention and ambiguous cases

Claude's installed native binary contains its protocol descriptions:
`interrupt_receipt_v1` advertises `still_queued`, UUIDs surviving interrupt.
`interrupt_cancel_queued_v1` advertises a separate `cancel_queued: true`
request option whose response carries `cancelled` UUIDs. OAR sends a plain
interrupt. The probe observed retention, not cancellation, and did not
exercise that optional native cancellation control. The mere presence of
those binary symbols is not proof that an ordinary interrupt discards input.

Pi 1.0.4's installed `pi-agent-core/dist/agent.js` separates `abort()` from
`clearSteeringQueue()`. `finishRun()` does not clear that queue. The
`agent-loop.js` loop drains steering at step boundaries and can append it
while an aborted tool settles; an aborted model response ends the run.
Thus even a turn with no later successful model call can retain steering
in its transcript. The later prompt confirmed inclusion.

Grok's inspected source snapshot is
[`77cd7eb`](https://github.com/xai-org/grok-build/blob/77cd7eb675ba911c225c3aaeeece3a20cbccc426/crates/codegen/xai-grok-shell/src/session/acp_session_impl/tasks_cancel.rs#L660),
not claimed to be the installed binary's exact revision. Normal cancellation
removes the running queue entry while retaining later real-user entries.
The `sendNow` replacement may have become the running entry before it reaches
the model. The immediate-abort probe reported zero elapsed time for that
replacement and could repeat the preceding prompt's usage; those numbers
are not a supported consumption receipt. Waiting until the steer reached
the provider gave the same cancellation category but preserved the steer in
later history. Neither queue disappearance nor `MidTurnAbort` safely proves
an unread input. A verified input-to-native-prompt association plus a reliable
native read/discard distinction is still needed before Grok can emit this
event. Early exploratory runs used tool names absent from the current catalog;
the final pair uses its advertised `run_terminal_command` and supersedes them.

Cursor's installed `run.d.ts` explains that `confirm_steering` remains
pending until either terminal acknowledgement. In `dist/esm/867.js`,
`contextInjectionState: delivered` resolves `complete_delivered`, while
cancelled, rejected and queued-for-next-turn resolve `revert_to_followup`.
Run cleanup also returns outstanding steers that way. OAR's run-end race
answers an outrun steer with a refusal. This was source and adapter-level
verification only: the local Cursor login substitute does not implement
agent streaming RPCs, and no new backend or real login was used.

## Process exit is a weaker observation

The conversation fold ends inputs still awaiting an echo on `exited`, with
`state: "dropped", reason: "runtime_exited"`. It changes no control receipt
and fabricates no native event. This means OAR did not observe a read before
the process ended. A last-moment read, an unwritten echo or a durable queue
can still leave input in a resumed transcript, so this reason is not a
guarantee that resending cannot duplicate input.
