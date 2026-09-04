# experiments

Manual experiment records against real runtimes — the analogue of OpenDAL's
`core/edge/`. Each file is a standalone script: run it, read its `OBSERVED`
header for the facts it pinned. Experiments burn real tokens, never run in CI,
and deliberately avoid repo machinery where independence is the point.

| Experiment | Fact it pins | Last observed |
|---|---|---|
| `claude-stream-json-input.ts` | stdin writable at every phase; single-step turns queue mid-turn input | 2026-08-21, claude 2.1.237 |
| `claude-stream-json-phases.ts` | multi-step turns absorb mid-turn input at the next step boundary (= steer); isolation/continuity/FIFO | 2026-08-21, claude 2.1.237 |
| `claude-session-adapter.ts` | adapter path: steer folds into the turn, abort exactly once, busy invariant | 2026-08-21, claude 2.1.237 |
| `codex-handshake.ts` | app-server initialize handshake shape | 2026-08-06, codex 0.144.6 |
| `codex-session-adapter.ts` | adapter path on codex: steer fold, abort, busy | 2026-08-21, codex 0.148.0 |
| `coxswain-say-bridge.ts` | OAR_SAY env indirection delivers without PATH lookup; Activity distinguishes redacted reasoning and exposes command input | 2026-08-24, codex 0.148.0 |
| `acp-runtime.ts <grok\|kimi>` | public adapter path: ACP handshake, shell-tool event lifecycle, text framing, and both account-usage readers | 2026-08-27, grok 1.0.5 + kimi 0.38.0 |
| `acp-vendor-snapshot.ts <grok\|kimi>` | scrubbed real ACP wire schema used to refresh the checked-in vendor fixtures | 2026-08-26, grok 1.0.5 + kimi 0.38.0 |
| `pi-sdk-import.ts` | the bundled sdk loads in-process; createAgentSession callable | 2026-08-21, pi sdk 0.84.2 |
| `session-resume.ts <runtime>` | Session.id is runtime-native; resume keeps the transcript | 2026-08-21, claude+codex |
| `session-queue.ts <runtime>` | queued input runs as an attributable spontaneous next turn | 2026-08-21, claude+codex |
| `codex-list-models.ts` | `codex debug models` = usable-now list from the active provider; slug is identity, display_name is not; ~1.8MB payload forces field projection | 2026-09-04, codex 0.149.0 |
| `claude-list-models.ts` | stream-json `list_models` control request; selector `value` vs `resolvedModel`; disabled entries prove login/CLI-version awareness | 2026-09-04, claude 2.1.237 |
| `pi-list-models.ts` | `pi --list-models` = live ModelRegistry (extension-registered, credential-scoped, volatile); `pi auth check` is typed but differently scoped | 2026-09-04, pi (local install) |
| `grok-list-models.ts` | ACP ext method `_x.ai/models/list` → SessionModelState with currentModelId; usable-now filtering + BYOK merge (pinned from source; script is the live re-check) | 2026-09-04, xai-grok-shell 1.0.12 source (bc7f02e) |
