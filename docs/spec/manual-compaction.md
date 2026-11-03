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
| `rejected` | It was not admitted, or the runtime refused the dispatched RPC without executing compaction; `code` and `reason` explain why. A dispatch acceptance stays accepted; the later native refusal remains in its correlated frame |
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
A Pi manual end or a correlated native response restores idle with the previous `lastTurnOutcome`.
Incremental hosts use the exported `StatusState` checkpoint type from
`@botiverse/oar/observe` (also exported at the root). Save the **entire** value
returned by `reduceStatus`, unchanged, together with the last consumed cursor;
continue with that value and records after the cursor. `initialStatus` starts
a new fold. `statusValue(checkpoint)` extracts `AgentStatus` for display, but
that display value and `Session.status().value` are not resumable checkpoints:
they omit correlation needed to match Claude's final command result.
Likewise preserve the entire `SessionView`, including optional `statusState`,
and the entire `TaskState`, whose `status` is a `StatusState`. Do not rebuild
either from only its displayed status.

The event identities have different meanings. `compactionId?` on
`compaction_started` and `compaction_ended` is the native compaction identity
(OpenCode v2's `messageId`), including on automatic compactions. The fold
learns this operation's identity from the first native **manual** start in
its exclusive idle window. It preserves that identity in `StatusState`;
old, different and missing identities cannot end that operation. An automatic
start cannot establish its identity, and an automatic end cannot settle it.
The envelope's `spanId` remains the native **turn** id (Cursor's run id),
never a replacement for a compaction message id. `compaction_ended.requestId?`
means the native response explicitly answered that OAR `compact` request:
Grok's dedicated RPC response can finish it without an observed start. No
request ownership is inferred from notification timing. Unowned ends retain
the previous rules.

The input gate and status change on the same retained native record:

| Runtime | Record releasing manual compaction |
|---|---|
| Claude | Matching command result, or a native cancellation before it starts |
| Codex | Completed native turn identified by its compaction item |
| Pi SDK / RPC | Native manual `compaction_end` (or the SDK's observed rejection) |
| Grok | The compact RPC answer, including refusal, failure or null result |
| OpenCode v2 | The compact prompt RPC answer, after recording preceding markers |
| Qoder | Matching `command_lifecycle completed/cancelled`, with or without an ordinary result |
| Cursor | The returned run's native terminal result, after the bounded stream drain |

Grok, OpenCode and Qoder compact requests carry
`settledBy: "native_response"`; their terminal frames carry the exact
`responseTo` request id. Earlier `turn_ended` and `compaction_ended` events
remain in place but do not release these operations. Other runtimes use their
existing terminal records. A synchronous observer of the release record can
submit another prompt when status is idle. Adapter-held inputs may instead
keep status at `running / waiting_model` until their dispatch or withdrawal.

Claude's native queued receipt for the compact command is not a pending
ordinary prompt. `turn_ended.inputId` and `inputIds`, when present, preserve native input
identities independently, without inference; see the
[identity projection](record-stream.md).

While compaction remains unresolved, a new `prompt`, `steer`, or `compact`
returns `rejected` / `busy`. Claude, Pi, Grok, Qoder, Cursor and OpenCode v2 retain `queue()` input in the
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

The [first report](../../experiments/manual-compaction-2026-11-02.md) and
[follow-up controls](../../experiments/manual-compaction-followup-2026-11-02.md)
retain the native evidence and its limits. Routine regressions require no
account credentials. Cursor's small real-account sample is experiment-only;
its unit regressions use a controlled SDK stand-in.

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
| OpenCode v2 | Session member supported, idle only; common v1/v2 Runtime undeclared. `/compact` emits native start/end metadata; the same `messageId` and the RPC answer are both required. Ordinary success is not proof. |
| Grok | Supported, idle only. Dedicated `_x.ai/compact_conversation` response proves completion, with structured failure/cancellation. No native start or inferred trigger. Empty history is a native successful no-op. |
| Qoder | Supported, idle only. `/compact` is intercepted before custom commands. Same-command UUID start, manual `compact_boundary`, and command completion/cancellation are required. A completed boundary wins later cancellation; a successful command without a boundary yields `not_compacted`. |
| Cursor | Supported, idle only. `Agent.summarize()` returns a run id; its root summary status and terminal run result identify completion. An aborted run without a terminal summary returns aborted without inventing a compaction end. |
| Pi Durable | Undeclared; handled with the separate Durable API migration. |

Claude's command-source read and dispatch are separate native messages, not
an atomic server operation. OAR checks the current same-process catalog and
writes immediately, refuses busy dispatch because queued commands can be
reparsed, and checks subsequent `commands_changed`. It cannot promise an
atomic snapshot across the remaining idle read/write window. It neither
reloads user commands nor overrides their configuration.

OpenCode's native markers can report `failed` even while the ordinary prompt
returns `end_turn`: provider failure, cancellation, empty history and an
invalid summary template are separate controls. Only matching native markers
prove completion. A known RPC answer without a matching marker returns
unconfirmed and releases the gate. A native RPC error is retained as a frame
and returns failed with that frame. Transport loss without a known answer
remains unconfirmed and reserved; dispose remains available. Qoder's completed boundary also remains completed
when its command later reports cancelled; the ordinary turn outcome stays as
reported, independently.

Cursor binds the accepted control to the SDK's returned run id before reading
its stream. The native `run_id` becomes the span identity; the envelope retains the root
session id and existing task/agentPath attribution. Summary ownership also
requires the native `agent_id` to match the root. A known terminal run with no terminal summary is unconfirmed
but releases the input gate because the run has ended. A lost stream or rejected
`run.wait()` cannot prove native completion; observation is unconfirmed and the
gate stays reserved until a terminal run or disposal is observed. The existing
two-second stream-tail budget does not fabricate a summary end. Real account
probes stay in experiments and never run in `check` or CI.

SDK 1.2.0 `summarize()` accepts no send options and internally uses empty
options. It cannot forward `local.force`: a restored agent whose store still
has an active run may refuse compact even when OAR has no live turn. The
[offline storage control](../../experiments/cursor-summarize-force-offline.ts)
confirms the refusal without launching an executor or using an account. OAR
does not call a private SDK method or expire the native run to work around it.
