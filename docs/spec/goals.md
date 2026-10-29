# Native goals

`Session.goal` is optional. Its presence means the selected session exposes
structured native goal controls. A host checks the member, never the runtime
name. OAR does not turn a goal into a prompt, run its own continuation loop,
or infer goal completion from an ordinary completed turn.

## Enabling and using the controls

Open with `SessionOptions.goals: true`. Codex enables its native goals feature
and exposes `goal`; all other runtimes refuse this option with
`UnsupportedOptionError("goals", reason)` before starting. The refusal is
also declared in `Runtime.refusedSessionOptions`.

Omission and `false` add no native override and expose no `goal` member.
They do not disable goals already enabled by native configuration. Codex
then still controls its own model tools and continuation, and any observed
goal notifications remain in the record stream. Supply `goals: true` again
on resume to expose the controls; OAR does not persist this launch choice.

```ts
const session = await runtime.session(installation, { cwd, goals: true });
if (session.goal !== undefined) {
  session.events((event) => {
    if (event.kind === "goal_changed" && event.sessionId === session.id) {
      showGoal(event.goal); // null is an observed absence, not an unknown value
    }
  }, { cursor: { sessionId: session.id, afterSeq: -1 } });
  await session.goal.read();
  const result = await session.goal.set({
    objective: "Finish the requested work", status: "active", tokenBudget: 50_000,
  });
  if (result.kind === "rejected") showRefusal(result.code, result.reason);
}
```

The methods are `set({ objective, status?, tokenBudget? })`, `read()` and
`clear()`. They return the same `ControlOutcome` as other session controls:
request and response records, plus `kind`, request `seq`, and rejection
`code` and `reason` when refused. The observed snapshot arrives through
`goal_changed`, including for `read()`; a successful call alone is never
interpreted as a goal state.

`objective` is required on `set`. Omitted status or budget leaves native
creation/update semantics in charge. An omitted budget does not promise to
clear a saved budget. A supplied budget must be a positive safe integer.
Unknown set-option keys and statuses the adapter cannot send are recorded
`unsupported` refusals before any RPC. Native rejections are recorded
`runtime_refused`, with the native answer retained subject to credential
redaction. Unreachable/disposed sessions use the ordinary control refusals.

## Observations and replay

`goal_changed { goal: GoalSnapshot | null }` is the single goal event.
`null` means a native reply or notification reported no goal. Without an
observation there is no event and no invented empty snapshot.

A snapshot contains native `objective` and `status`. Known status words are
`active`, `paused`, `blocked`, `usageLimited`, `budgetLimited`, and `complete`;
an unfamiliar native string remains visible unchanged. Optional
`tokenBudget`, `tokensUsed`, `timeUsedSeconds`, `createdAt` and `updatedAt`
are included only when reported. Zero is retained; `tokenBudget: null`
means the runtime reported no budget. Times are native Unix epoch seconds.
These goal counters may span a resumed thread's life; they are separate
from OAR's per-Session token totals.

Controls record `goal_set {options}`, `goal_read`, or `goal_clear` requests.
A native reply is recorded as a Frame at its wire position, with its
verbatim `native` and observed `goal_changed` in `events`. Notifications
carry the same event in their ordinary frame. The separate response only
answers accepted or rejected; it carries no state events. Events inherit the containing record's attribution and
sequence, so replay reads exactly the same facts in the same order. A reply
and a following notification may repeat a snapshot; both observations stay.
Malformed replies remain frames without events and are rejected without
fabricating a snapshot. Rejections,
requests and ordinary turn endings never change goal state optimistically.

Goal changes neither begin nor end an OAR turn. Native `turn/started` and
`turn/completed` still decide activity and completion, including spontaneous
turns. Goal events do not add transcript messages or alter `Session.status()`.
A host waiting for the goal watches its own session's goal snapshots rather
than treating `promptAndWait` or `awaitIdle` as goal-completion helpers.

## Codex boundary

Codex maps these controls to `thread/goal/set`, `thread/goal/get`, and
`thread/goal/clear`; explicit host mutations use native `origin: "user"`.
Its two notifications are `thread/goal/updated` and `thread/goal/cleared`.
Enabling the feature exposes three model tools even before a goal exists,
which is why OAR requires an explicit session opt-in. A conflicting launch
setting that leaves the feature disabled makes session opening fail.

Native goals require persistent threads. Disabled-feature and ephemeral
thread calls are refused natively. A paused goal survives a process restart
and is reported on resume. Pausing during a running turn changes the goal
but does not abort that turn; clearing is also not an abort. `abort()` keeps
its ordinary turn-only contract. Codex owns subsequent continuation, usage
limits, budgets and completion; OAR does not add retries or evaluate success.

Claude's `/goal` command does not provide the structured state on its chosen
transport, so it has no `Session.goal`. OAR never translates this API into
that command. See the [Codex mapping](../runtimes/codex.md#native-goals) and
[native boundary evidence](../../experiments/codex-goal-boundaries-2026-10-29.md).
