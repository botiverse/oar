# Questions to the user (2026-11-25, Linux x64)

Real binaries against aimock, no account: `pnpm tsx experiments/user-questions-native.ts claude|codex [command] [cases]`
([script](user-questions-native.ts)). Claude 2.1.332 (all cases) and 2.1.274 (bash, ask, deny, interrupt, no-plan);
Codex 0.172.0 (all cases) and 0.105.0, 0.106.0, 0.107.0, 0.111.0, 0.118.0, 0.145.0 (one answer).

## Claude

With `--dangerously-skip-permissions --permission-prompt-tool stdio`:

| Case | Observed |
|---|---|
| Bash, Write | Run; no `can_use_tool` |
| `AskUserQuestion` | `can_use_tool`, `requires_user_interaction: true`; the turn waits |
| `answers` by question text, one string each | Tool result: `Your questions have been answered: "Which color?"="Red", "Which sizes?"="S, M"...` |
| An array for several choices | Accepted, joined as `S,M` |
| Text that is no option | Tool result: `The user answered: ... Read the answers carefully...` |
| One of two questions answered | Accepted; only that one is reported |
| `behavior: "deny"` | `message` is the tool result; listed in `permission_denials`; the turn continues |
| Interrupt while open | `control_cancel_request` (same id), then the interrupt's `control_response`, then `result` (`error_during_execution`) |
| `EnterPlanMode` | Enters plan mode with no request |
| then `ExitPlanMode`, or `Write` | Each asks `can_use_tool`; denied, so plan mode cannot be left |
| `--disallowed-tools EnterPlanMode ExitPlanMode` | Neither is available; `AskUserQuestion` stays |

Without the prompt target (or with `--permission-prompts none`) neither `AskUserQuestion` nor `EnterPlanMode` is available.

## Codex

With `-c features.default_mode_request_user_input=true` in Default mode:

| Case | Observed (0.172.0) |
|---|---|
| Feature off | Tool result: `request_user_input is unavailable in Default mode`; no request |
| Feature on | `item/tool/requestUserInput`; `isOther: true`, `isSecret: false`, `isBlocking: false`, `autoResolutionMs: null` |
| Any answer strings | Reach the model verbatim as `{"answers":{"color":{"answers":[...]}}}`; then `serverRequest/resolved` |
| `{ answers: {} }` | Same; the turn continues |
| `turn/interrupt` while open | Its reply, `turn/completed` (`interrupted`), then `serverRequest/resolved` |

| Version | Asks | `serverRequest/resolved` |
|---|---|---|
| 0.105.0 | no | - |
| 0.106.0 | yes | no |
| 0.107.0, 0.111.0, 0.118.0, 0.145.0, 0.172.0 | yes | yes |

Not run: a secret question from a model, `autoResolutionMs`, a question from a subagent, macOS and Windows.
