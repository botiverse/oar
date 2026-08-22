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
| `pi-sdk-import.ts` | the bundled sdk loads in-process; createAgentSession callable | 2026-08-21, pi sdk 0.84.2 |
| `session-resume.ts <runtime>` | Session.id is runtime-native; resume keeps the transcript | 2026-08-21, claude+codex |
| `session-queue.ts <runtime>` | queued input runs as an attributable spontaneous next turn | 2026-08-21, claude+codex |
