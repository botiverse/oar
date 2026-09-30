# Live model and effort changes

Local probe investigation, 2026-09-29: claude 2.1.284, codex-cli 0.155.1,
grok 1.0.41, kimi 2.0.0, pi SDK 0.84.2. Reproduction:
[experiments/effort-channels.ts](../../experiments/effort-channels.ts). This
page records native facts for a later `Session.configure` design; nothing on
it is implemented.

**The question.** Which native surface changes the model and/or reasoning
effort of a *running* session between turns, without restarting the
runtime process, and how would that meet each adapter's queue? Today OAR
applies both at open only (`SessionOptions.model` / `effort`, read back
against the runtime's own report). A host that switches mid-conversation
disposes the Session at a turn boundary and resumes the runtime-native id
with new options: a process restart and a new handshake, where claude
also re-runs its SessionStart hooks and every runtime starts its MCP
servers again.

## What each runtime offers

| Runtime | Model, live | Effort, live | The runtime's word afterwards | Queue that a change must be ordered against |
|---|---|---|---|---|
| claude 2.1.284 | control request `set_model {model}` | control request `apply_flag_settings {settings: {effortLevel}}` (`set_max_thinking_tokens` is the older budget knob) | both answered `success` only; `get_settings.applied.{model, effort}` then reports the change | adapter-held (OAR drains one message per turn end by writing stdin) |
| codex 0.155.1 | `thread/settings/update {threadId, model}` (experimental API, which OAR enables; OAR already uses it at open to set a resumed thread's effort) | `thread/settings/update {threadId, effort}` | reply `{}`, then `thread/settings/updated {threadSettings: {model, effort, ...}}` | native (`thread/queue/add`): a drained submission runs the thread's current settings |
| grok 1.0.41 | `session/set_model` or `session/set_config_option {configId: "model"}` | `session/set_config_option {configId: "reasoning_effort"}` | the answer's `configOptions` (current values), a `config_option_update` push, and `_x.ai/session_notification model_changed {model_id, reasoning_effort}` | adapter-held (OAR drains one prompt per turn end) |
| kimi 2.0.0 | `session/set_model` (also a `model` config option) | `session/set_config_option {configId: "thinking"}` | the answer's `configOptions` and a `config_option_update` push | adapter-held |
| pi SDK 0.84.2 | `AgentSession.setModel(model)` | `AgentSession.setThinkingLevel(level)` | `thinking_level_changed {level}`; `AgentSession.model` / `thinkingLevel` getters | adapter-held (OAR starts the next held input at `agent_settled`) |

Probed, token-free:

- **claude:** on one idle process opened with `--model sonnet --effort low`,
  `set_model opus` moved `get_settings.applied` to `claude-opus-5-5` / `low`,
  `apply_flag_settings {effortLevel: "high"}` to `high`, and `set_model haiku`
  to `claude-haiku-4-5-20251001` / `null` (the model takes no effort). Every
  answer was a bare `success`, and `apply_flag_settings` answers `success`
  for an unknown level too, so only a `get_settings` read-back tells what
  took effect. `system/init` says `per_turn_effort_active: true`: claude
  sends an effort change inside the conversation at the turn where it
  changes, keeping the prompt cache (`system/per_turn_effort_changed` reports
  a fallback). `update_settings` writes settings *files* and is not a
  session setter.
- **codex (aimock provider):** between two turns of one thread,
  `thread/settings/update {effort: "high"}` answered `{}`, codex pushed
  `thread/settings/updated` with `effort: "high"`, the next prompted turn's
  Responses request carried `reasoning.effort: "high"`, and so did the turn
  codex started from its own queue afterwards. `thread/queue/add` takes no
  per-submission overrides (`threadId`, `input`, `clientUserMessageId`).
  `turn/start` also takes `model` / `effort` ("for this turn and subsequent
  turns"), and `turn/settings/update {turnId, model, effort}` changes one
  *running* turn only ("not future turns"). `config/value/write` edits
  `config.toml` and is not a session setter. A `config` override on
  `thread/resume` is not one either: it rebuilds the thread's settings from
  `config.toml`, so a resume that does not repeat `model` switches to the
  configured default (live: `gpt-6-luna` came back as `gpt-6-astra`), and
  the rebuild stays with the thread even without a turn.
  `thread/settings/update` to the level a thread already runs pushes
  nothing.
- **grok, kimi:** `session/set_config_option` works on an idle session, with
  no prompt needed. A model switch re-derives the effort option's menu for
  the new model: grok-4.5 offers high/medium/low where grok-4.7 adds xhigh,
  and kimi-k2.5 offers off/on/low where k3 offers low/high/max, keeping a
  level the new menu still has. An unknown value is refused
  `-32602 Invalid params`.
- **pi:** both setters write pi's *global* settings as the user's new default
  (`settingsManager.setDefaultModelAndProvider`, `setDefaultThinkingLevel`
  when the level changes; agent-session.js 0.84.2), besides appending
  `model_change` / `thinking_level_change` to the session file.
  `setThinkingLevel` clamps to the model's levels as creation does.

Not probed anywhere: a change *during* a turn (claude and ACP accept the
request at any time, but when it reaches the running model calls is
unknown; codex's `turn/settings/update` is the one surface documented for
it), and a change racing a queued input.

## What a `Session.configure` would have to settle

- **A control like the others.** A `configure` request record answered by
  the runtime's own acknowledgement. The effect is the `model` / `effort`
  events the runtime then says, never the request echoed (the same rule the
  open-time read-back follows). claude acknowledges with a bare `success`,
  and its only report is `get_settings`, whose answer also dumps the merged
  settings. It would be consumed unrecorded, as at open
  ([decision](../design/decisions.md#recording-claudes-effort-read-back-2026-09-29)),
  and claude's `effort()` would stay null.
- **Turn boundaries and queues.** Applied while the session is idle, the
  change must still be ordered against queued input. On the adapter-held
  queues (claude, grok, kimi, pi), the adapter drains the next held input at
  the turn end, so a configure accepted before a drain must be sent (and
  answered) before that drain's prompt; a configure issued mid-turn waits
  for the boundary or is refused `busy`. Codex holds its queue natively, and
  `thread/settings/update` already governs a drained submission, so there
  the ordering is codex's own.
- **Where the setter has side effects.** pi's setters rewrite the user's
  global defaults. A configure through them would need that accepted as
  pi's semantics or avoided by other means. The restart path passes
  creation-time options, which write only the session file.
- **Resume semantics stay separate.** What a resume restores when it is
  asked for nothing differs per runtime: codex, grok and kimi restore the
  level the session last ran with; pi restores the level its session file
  recorded, and an explicit level on resume is not recorded; claude restores
  none. A configure would change the running session. What the next resume
  restores remains each runtime's rule and belongs in its page. The restart
  path is safe to rely on: every option given with `resume` now applies or
  refuses the open (oar#22), so a switch by dispose and resume cannot keep
  the old model or prompt silently.
