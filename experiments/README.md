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
| `session-resume.ts <runtime> [modelA] [modelB]` | Session.id is runtime-native; resume keeps the transcript; pi: id is the session file's header id under `<agentDir>/sessions/--<cwd slug>--`, `SessionManager.list`+`open` resumes it, and an explicit `provider/model` on resume replaces the recorded model (read back via `Session.model()`) | 2026-08-21, claude+codex; 2026-09-05, pi SDK 0.84.2 (pi-mono v0.84.2 914cf1472) |
| `session-resume-model.ts [X] [Y]` | codex: `thread/resume {model}` switches the model on a cold load and the response `model` is the effective one; a resume on a connection already subscribed to the loaded thread drops the override and reports the old model (why the adapter checks the response); unused threads have no rollout to resume | 2026-09-05, codex 0.153.4 (tag rust-v0.153.4, 3d2ee51c) |
| `session-queue.ts <runtime>` | queued input runs as an attributable spontaneous next turn | 2026-08-21, claude+codex |
| `codex-list-models.ts` | `codex debug models` = usable-now list from the active provider; slug is identity, display_name is not; ~1.8MB payload forces field projection | 2026-09-04, codex 0.149.0 |
| `claude-list-models.ts` | stream-json `list_models` control request; selector `value` vs `resolvedModel`; disabled entries prove login/CLI-version awareness | 2026-09-04, claude 2.1.237 |
| `pi-list-models.ts` | `pi --list-models` = live ModelRegistry (extension-registered, credential-scoped, volatile); `pi auth check` is typed but differently scoped; in-process `getAvailableSnapshot()` is empty until `getAvailable()` runs, and a bare `ModelRuntime.create()` misses extension-registered providers — `createAgentSessionServices` loads them like `pi --list-models` does (the two halves of the `oar models pi` "no models" bug) | 2026-09-05, pi (local install) + SDK 0.84.2 |
| `grok-list-models.ts` | ACP ext method `_x.ai/models/list` → SessionModelState with currentModelId; usable-now filtering + BYOK merge (pinned from source; script is the live re-check) | 2026-09-04, xai-grok-shell 1.0.12 source (bc7f02e) |
| `kimi-list-models.ts` | no list method: `kimi acp` `session/new` response carries `configOptions` id `model` (usable-now list from kosong.listModels) + a `thinking` option for the current model only; `session/new` is auth-gated (-32000) (pinned from source; script is the live re-check) | 2026-09-05, kimi-code 0.41.0 source (f9ca33376) |
| `session-model-readback.ts [runtime]` | `Session.model()` is the runtime's report, not the request: codex `thread/start|resume` response `model` (at open); claude `system/init` frame `model` (null before the first turn, alias `haiku` reads back as the resolved id); pi `AgentSession.model` as `provider/id` (at open); grok `models.currentModelId` / set_model `_meta.model` and kimi `configOptions` id `model` + `config_option_update` before the set_model answer are pinned from source (no local binary) and exercised only against the ACP fixture | 2026-09-05, codex 0.153.4 + claude 2.1.261 + pi SDK 0.84.2; grok 1.0.12 source (bc7f02e), kimi-code source (f9ca33376) |
| `kimi-usage-update-order.ts [fixture\|live]` | kimi answers `session/prompt` before pushing the turn's `usage_update` from an un-awaited task (`onTurnEnded` → `void emitUsageUpdate()`, which may skip the push), so `contextUsage()` at `turn_ended` was one turn behind; the kimi profile's `usageUpdateAfterPrompt` holds the turn ≤500 ms for it (pinned from source, exercised against the fixture; `live` is the re-check) | 2026-09-05, kimi-code 0.41.0 source (f9ca33376) |
