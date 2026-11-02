# Manual compaction

A host restoring different system instructions can need native compaction
before its next input. `Session.compact()` requests that native operation and
waits for evidence that it finished. OAR does not summarize history itself,
start a replacement session, or treat an ordinary successful prompt as proof
of compaction.

## Discovery and results

`Runtime.manualCompaction` is optional:

- `{ kind: "supported", activeTurn: "reject" | "queue" }` describes the
  adapter's policy. Current implementations all reject busy sessions.
- `{ kind: "unsupported", reason }` explains a measured missing native
  capability. An absent declaration means unverified, not unsupported.

The opened session's optional `compact` member is the actual capability.
Unsupported sessions omit it. A supported member can refuse the current
state or configuration with a typed result, for example Claude's project
command shadowing its built-in command.

```ts
const outcome = await session.compact?.({ timeoutMs: 30_000, signal });
if (outcome?.kind === "completed") {
  await session.prompt("Continue with the current instructions.");
}
```

`CompactionOutcome` retains the `compact` request and, when already observed,
its response. The response accepts or rejects the operation; acceptance is
not completion. Results are:

| `kind` | Evidence and caller meaning |
|---|---|
| `completed` | A native frame proves this operation completed; `frame` points at that record |
| `rejected` | It was not admitted; `code`, `reason` and the rejection response explain why |
| `failed` | Native failure (`native_failed`), command-source change (`command_changed`), or a command that ended without compaction (`not_compacted`); native evidence remains available |
| `aborted` | The native operation reported cancellation, with its `frame` |
| `unconfirmed` | Observation ended without a confirmed outcome: `timeout`, `signal`, `disposed`, `runtime_exited`, `session_released`, or `observation_failed` |

`timeoutMs` must be finite and non-negative. Omitting it waits until native
settlement or session loss. A signal already aborted at invocation returns
`rejected` with code `aborted`, without sending a native operation.
`timeoutMs: 0` still dispatches and does not wait. After dispatch, expiration
or signal cancellation stops **waiting only**; it returns `unconfirmed`,
never cancels the native operation or manufactures a compaction end. A late
native result still enters the same record stream. A subsequent call does not
resume the old wait: it is a new request and is rejected `busy` while the old
operation remains unresolved.

## Ownership, records and state

Compaction result reasons use the same credential redaction as session records.

The adapter reserves one compaction operation before publishing its request,
so synchronous record observers cannot acquire it twice. Completion belongs
to that operation through native command/turn/item identity, or an exclusive
idle operation with native manual start/end facts. Children, other sessions,
previous turns, and automatic boundaries cannot satisfy the wait.

`status()` is reconstructed from records. From the admitted control's request
until its native terminal evidence it reports `running`, phase `compacting`,
including after a caller stops waiting. A rejected request releases that
provisional status. This control intent does not fabricate a native
`compaction_started` event. `AgentStatus.compaction` exposes only `requestId`
and optional `started`; correlation and the previous turn outcome stay in
serializable reducer bookkeeping, separate from the displayed status.
A Pi manual end restores idle with the previous `lastTurnOutcome`.
The fold retains correlation in its checkpoint;
Claude's native queued receipt for the compact command is not a pending
ordinary prompt. `turn_ended.inputId` and `inputIds`, when present, preserve native input
identities independently, without inference; see the
[identity projection](record-stream.md).

While compaction remains unresolved, a new `prompt`, `steer`, or `compact`
returns `rejected` / `busy`. Claude and Pi retain `queue()` input in the
existing OAR queue and drain it after native completion; Codex refuses new
queue input `busy` because its native queue could start another turn during
compaction. A submitted but not yet started input also prevents compact.
`abort()` uses the native cancellation control once it has a target. Before
native admission or Codex's compaction item identifies a turn, it returns
`busy` with the missing-target reason. Claude's queued `cancelled` command
settles as `aborted`. Once Claude starts compacting, interrupt stops it but
Claude reports `compact_result: failed`, so the compact result is `failed`
with `native_failed`; OAR does not reclassify its error text. The ordinary
`turn_ended: aborted` follows OAR's turn cancellation convention and is a
separate observation. Codex and Pi retain their native aborted/failed report.
`dispose()` still stops/releases the session through its ordinary lifecycle;
process exit and session release end the wait as `unconfirmed` if native
completion was missing. There is no OAR deadline that pretends the operation
finished and unlocks it. Pi RPC exempts this operation from its ordinary
30-second RPC deadline for that reason.

## Current scope and completion evidence

These observations are backed by the [native regression and report](../../experiments/manual-compaction-2026-11-02.md),
using scripted local providers without account quota.

| Entry | Declaration and native boundary |
|---|---|
| Claude stream-json | Supported, idle only. Same-process `initialize.commands` must identify built-in `compact` with no non-builtin entry of that name; command lifecycle, manual `compact_boundary`, and matching result identify completion. Source changes before the boundary fail the operation. A native compaction failure overrides a successful ordinary result. |
| Codex app-server | Supported, idle only. `thread/compact/start` accepts; the root turn's started/completed `contextCompaction` item and matching completed turn prove completion. Local compaction tested; ChatGPT-login remote compaction has source evidence only, no live test. |
| Pi SDK / RPC | Supported, idle only. Native `compact()` / RPC `compact`, manual start/end with native failure/cancellation preserved. |
| Kimi | Unsupported: ACP has no structural completion signal for this operation; text is insufficient. |
| Qwen | Unsupported: stream-json lacks structural completion evidence and a user command can replace `/compress`. |
| Antigravity | Unsupported: current native interface has no manual compaction control. |
| CodeBuddy | Unsupported: the dedicated method in published types is refused by the CLI; slash-command completion/provenance is not established. |
| OpenCode v1 | No session member: a project command can replace `/compact` and structural completion is unverified. The shared v1/v2 Runtime remains undeclared. |
| OpenCode v2, Grok, Qoder, Cursor, Pi Durable | Undeclared pending their own control/correlation regressions. |

Claude's command-source read and dispatch are separate native messages, not
an atomic server operation. OAR checks the current same-process catalog and
writes immediately, refuses busy dispatch because queued commands can be
reparsed, and checks subsequent `commands_changed`. It cannot promise an
atomic snapshot across the remaining idle read/write window. It neither
reloads user commands nor overrides their configuration.
