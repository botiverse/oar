# Grok interjection and Grok's own turns

Grok 1.0.77 (`50ca579fa996`), Linux arm64, 2026-11-10. Raw ACP stdio against
a local scripted provider (aimock): no login, no tokens. Source read at
grok-build `2bdd1d6` (`extensions/interject.rs`,
`session/acp_session_impl/interjection.rs`, `run_loop.rs`
`SessionCommand::Interject` and `Cancel`, `agent/mvp_agent/acp_agent.rs`
`prompt`).

```sh
pnpm tsx experiments/grok-interject/probe.ts <grok-binary> out.json
```

[`selected.json`](selected.json) keeps the interjection, queue, turn-end and
prompt-answer frames of the run below (usage ledgers and the session list
removed).

## Results

| Case | Sent | Native result |
|---|---|---|
| A: interject while a 4 s command runs | `session/prompt` named `oar-prompt-a`; after the `tool_call`, `_x.ai/interject {text, interjectionId}` | Reply `{result: {status: "queued"}}` in about 1 ms, then `_x.ai/session/interjection` echoing text and id. After the command, the next provider request contains the text. One `turn_completed` and one `end_turn` answer for `oar-prompt-a`, two model calls; nothing cancelled. |
| B: interject while idle | `_x.ai/interject` after A's answer | Same reply and echo, then `_x.ai/queue/changed` `runningPromptId: interject-fallback-<uuid>` (`runningText` the interjection), a model call and `turn_completed` for that id. No `prompt_complete` and no RPC answer: Grok's own turn. |
| C: interject, then cancel | As A (6 s command), `session/cancel` 0.5 s after the reply | `turn_completed` `cancelled` and the answer `cancelled` / `MidTurnAbort`. In the next 8 s no provider request contains the text and no further turn starts: the buffer was cleared. |
| D: client prompt id | `_meta.promptId` on every prompt | Used verbatim: `_x.ai/queue/changed` `entries[].id` then `runningPromptId`, `turn_completed.prompt_id`, the answer's `_meta.promptId`. |

The probe also logged an unrelated background request to xAI's own API
(rejected, dummy key); it did not affect the turns.

## What the source adds

- The reply is sent as soon as the command is queued to the session actor;
  it says nothing about consumption.
- A running turn buffers the interjection and takes it at safe points
  (`drain_interjections_at_safe_point`: after a tool batch, at the top of the
  loop, before the turn returns). Taking it only writes a user message to the
  session file (`persist_synthetic_user_message_with_model`); no live
  notification follows.
- An interjection that lands after the final drain, or while idle, becomes a
  front-of-queue prompt `interject-fallback-<uuid>` (`flush_stranded_interjections`,
  `queue_interjection_fallback_prompt`), so it is never silently lost.
- `SessionCommand::Cancel` clears the buffer ("Clear, don't flush: converting
  interjections to prompt turns would restart the model after a stop").
- Grok starts other turns of its own under ids such as `subagent-completed-*`,
  `bash-completed-*`, `goal-summary-*` and `exit-plan-mode-resume-*`; a
  client-supplied `_meta.promptId` replaces the generated UUID.

## OAR mapping

Steer is `_x.ai/interject`; OAR names its prompts and treats every other root
prompt id as Grok's own turn
([grok](../../docs/runtimes/grok.md#prompting-steering-queuing-and-cancellation)).
The live counterpart through OAR is
[`grok-interject.vendor.test.ts`](../../sea-trial/vendor/grok-interject.vendor.test.ts)
(steer joins the turn; abort drops an untaken interjection), passing on
1.0.77 with the 17 applicable behavior cases and the other Grok vendor tests.
Case B through OAR is covered by the fixture tests only: OAR rejects a steer
when no turn runs, and the late-drain window cannot be hit reliably live.
