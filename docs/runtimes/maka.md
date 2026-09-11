# Maka — reference runtime

Reviewed **2026-09-08** at Maka [`a96de5e2`][source] and OAR `9b102d0`.
**OAR has no Maka adapter.** This page examines its programmatic agent interface;
no model calls or tests were run.

## Native core concepts and calling interfaces

### Core concepts

Maka owns its agent loop through `AiSdkBackend`; its `openai-codex` model adapter
uses OpenAI Responses, not the Codex app-server. External-agent history import
and benchmark command execution are separate integrations. [Backend kinds][backend],
[model factory][factory], [external history][external].

A **Session** is persistent conversation/configuration identity. A **Turn** is
an admitted execution request; its **Run** identifies execution. The caller
supplies a new turn ID to start a continuation, while the Host supplies its run
ID. A source run and its RuntimeEvent high-water identify the exact continuation
boundary. They differ from a subscription's delivery sequence or a transcript
pagination cursor.

An API result saying `started` is not task completion. `TurnSnapshot` contains
`sessionId`, `turnId`, `runId`, and status: `admitted`, `created`, `running`,
`waiting_for_user`, `completed`, `failed`, or `cancelled`. Terminal snapshots
also carry terminal-event identity and failure/abort details. [Turn protocol][turn].

### Calling interfaces

| Entry point | What a caller can use | Availability boundary |
|---|---|---|
| `@maka/runtime-host/client` | Connectors, typed `RuntimeHostConnection.request(operation, input)`, and session subscriptions. | Exported workspace package, `private: true`, version `0.1.0`; external SDK stability/publication is unestablished. |
| `@maka/runtime-host/protocol` | Operation input/output types, decoders, declared errors, and compatibility definitions. | Actual client/server contract; connections negotiate compatibility. |
| `@maka/runtime/session-manager` | `sendMessage(...)`, continuation planning, and `resumeSafeBoundaryContinuation(...)` as an async event iterable. | Lower-level exported facade requiring runtime/store/backend dependencies; Host admission and client-capability setup remain separate. |
| CLI session driver / Desktop wrapper | CLI `switchSession()` and `resumeLatest()`; Desktop `queryTurnResume()` and `startTurnResume()`. | Application wrappers around Host operations. CLI has empty package `exports`; its driver is an implementation example. |

Sources: [Host exports][host-package], [client contract][connection],
[runtime exports][runtime-package], [SessionManager][manager],
[CLI package][cli-package], [CLI driver][driver], [Desktop wrapper][desktop].

## High-level mapping to OAR

These are **reference-only conceptual correspondences**, not implemented Maka
adapter behavior. Today's [OAR Session contract](../../packages/oar/src/contracts/session.ts)
wraps external runtimes through a narrower control/observation interface.

| Maka concept | Current OAR counterpart or gap |
|---|---|
| Persistent Session | `Session.id` and `SessionOptions.resume` preserve/reopen native conversation identity on existing backends. |
| Host-admitted Turn plus Run | OAR has a Turn handle and outcome; it does not expose Maka's separate durable admission/run identities. |
| Session subscription, state snapshot, paged transcript | OAR `subscribe()` carries a selected live event projection; public history hydration and persistent replay cursors are absent. |
| Planned continuation from a source boundary | OAR resume is conversation reopening, without query/start recovery planning or a validated source high-water. |
| Client capabilities and interaction settlement | OAR currently uses noninteractive adapter policies, without a general caller request/decision interface. |

The detailed sections below describe native APIs first and identify their OAR
correspondence. A future integration would need its own compatibility and
behavior evidence.

## Per-feature correspondence

### Host connection and ownership

`connectExistingRuntimeHost({rootPath, protocol, ...})` discovers an already
registered Host without filesystem writes. `rootPath` identifies Maka's state
root, not just a session working directory. Its result is `connected`,
`incompatible`, `upgrade_required`, `draining`, or `unavailable`; only `connected`
supplies a usable connection. `connectRuntimeHost` and remote connectors are
also exported. [Connection/bootstrap][connection].

Subscriptions and connections have separate `close()` methods. Releasing a
client connection is not the targeted stop operation. An OAR adapter would need
to define whether it owns the Host or merely its connection; current OAR's
process-owning adapters do not establish that answer for Maka.

### Session creation and configuration

`session.create` accepts caller session identity, workspace, model target, and
optional thinking/tool/permission/collaboration/orchestration settings.
`session.configuration.update` uses `{sessionId, expectedRevision, patch}`;
model/thinking/permission changes are not arbitrary resume fields.
[Configuration protocol][catalog].

OAR exposes initial cwd/model/instruction options but no equivalent general
revision-checked configuration operation. Mapping similarly named settings
would require checking the accepted native values and effective configuration.

### Attach, observe, and retrieve history

Use `session.catalog.query` to discover sessions and
`connection.openSessionSubscription({sessionId, transcript: {kind: 'tail', maxBytes}})`
to obtain current session/root-turn state, transcript bootstrap, and live updates.
The subscription supports paged history and decoded transcript loading.
[Subscription contract][subscription], [subscription client][subscription-client].

CLI `switchSession(sessionId)` uses this path and can attach to an already
active turn. It does not itself start inference. This is distinct from OAR's
resume-and-open operation and from its live-only `subscribe()`.
[CLI switching][switch].

### Start a new prompt

`turn.start` takes
`{sessionId, turnId, content, skillIds?, turnOrchestration?, maxSteps?}`.
Its result is `started` with a turn snapshot and skill-invocation result, or
`blocked` with the skill-invocation result. OAR's `prompt(string)` instead
returns a local Turn handle or `busy`; starting and native admission would need
an explicit mapping. [Turn start][turn].

### Stop and regenerate

`turn.stop({sessionId, turnId, runId})` targets an exact execution and returns a
snapshot. A stale run must not be silently retargeted. `turn.regenerate` uses
`{sessionId, sourceTurnId, turnId}` for a separate regeneration request.
OAR exposes handle-bound abort but no regenerate method. [Turn operations][turn].

### Resume incomplete execution

This operation continues a failed/cancelled run from a validated execution
boundary, creating a new continuation turn without a new user message.
**It is disabled by default in the inspected production composition:** the Host
requires `MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1`. Ordinary session observation and
subsequent messages do not require this recovery flag. [Production wiring][feature].

#### Query the continuation boundary

```ts
// operation: "turn.resume.query"
{ sessionId: string,
  sourceRunId?: string,
  expectedRuntimeEventHighWater?: number }

// Result
{ sessionId: string, disposition: "ready",
  sourceRunId: string, sourceTurnId: string,
  sourceRuntimeEventHighWater: number }
// or
{ sessionId: string, disposition: "parked", reason: TurnResumeParkReason }
```

Omitting `sourceRunId` selects the latest failed/cancelled top-level candidate;
not every historical turn is resumable. An expected high-water requires a
source run and must be a positive integer. `ready` is a plan, not a reservation;
start rechecks the boundary and admission state. [Candidate selection][candidate],
[input validation][validation], [Host admission][admission].

#### Start and observe the continuation

This call fragment assumes an **already connected client and existing session**,
with observation arranged. The caller allocates and retains `newTurnId` for this
logical continuation. It follows CLI `resumeLatest()`; bootstrap and event
consumption are omitted. [CLI flow][resume-driver].

```ts
import type { RuntimeHostConnection } from '@maka/runtime-host/client';

async function startContinuation(
  connection: RuntimeHostConnection,
  sessionId: string,
  newTurnId: string,
) {
  const plan = await connection.request('turn.resume.query', { sessionId });
  if (plan.disposition === 'parked') return { kind: 'parked' as const, plan };

  return connection.request('turn.resume.start', {
    sessionId,
    turnId: newTurnId,
    sourceRunId: plan.sourceRunId,
    sourceRuntimeEventHighWater: plan.sourceRuntimeEventHighWater,
  });
}
```

Start returns `{kind: 'started', turn: TurnSnapshot}` or `{kind: 'parked', plan}`.
Copy source identifiers from the plan; `turnId` must differ from `sourceTurnId`.
Observe completion through the session subscription or
`turn.query({sessionId, turnId})`. The CLI opens its event channel before start.
[Turn protocol][turn], [CLI flow][resume-driver].

#### Errors, retries, and concurrent callers

- **Parked:** reasons include missing/unreadable source, disabled feature, busy
  session, failed safety check, unavailable authority/observation, existing
  continuation, required repair, and indeterminate started work. These are typed
  `TURN_RESUME_PARK_REASONS`; internal diagnostics can be more specific.
- **Operation failure:** `RuntimeHostOperationError` exposes `operation` and
  `code`. Resume declares readiness/draining, unavailable operation,
  missing/archived session, and internal failure; start additionally declares
  `session_busy` and `operation_conflict`.
- **Idempotent identity:** the same session/turn and source boundary can return
  the existing continuation, including its terminal snapshot. Changing the source
  boundary while reusing a turn ID conflicts. Two-client tests assert identical
  starts create one run and no user message, not universal exactly-once effects.
- **Unknown command outcome:** `RuntimeHostRequestInterruptedError` distinguishes
  `not_dispatched`/`dispatched` and timeout/connection loss. Queries are retryable;
  dispatched commands are not automatically retryable. Reconnect and inspect the
  known turn before selecting recovery; do not invent a new ID after a timeout.
- **Admission:** unrelated active/pending root work can block continuation.
  Children must continue through their parent; import staging, absent account
  selection, and reserved coordination sessions can also prevent execution.

Evidence: [error classes][connection], [operation declarations][turn],
[admission/idempotence][admission], [two-client test][concurrency],
[session availability][availability]. Safety checks include workspace, background
operations, tools, and source execution state. These explain the refusal modes;
OAR has no corresponding continuation-plan API. [Planner][candidate].

### History import and branching

`external-session.import({adapterId, sourceSessionId})` returns a Maka
`SessionCatalogItem`. This imports transcript history; it does not reattach to a
running Claude/Codex process. `session.branch.create` is another separate
operation. Current OAR exposes neither history import nor branch creation.
[Import protocol][import], [branch protocol][branch].

### Interactions and client capabilities

The Host connection exports `replaceClientCapabilities(provider)` and
`unregisterClientCapabilities()`; session configuration includes permission mode.
These are distinct interfaces from receiving text or accepting a turn. Current
OAR has no general client-capability registration or interaction reply channel.
The reviewed API inventory does not establish a complete interaction-callback
mapping for a future adapter. [Connection contract][connection],
[configuration][catalog].

## Verification

[Protocol tests][protocol-tests] check request/response identity;
[Host continuation tests][concurrency] cover same-operation concurrency, retries,
startup recovery, and indeterminate work. They were inspected, not run. A future
integration still needs bootstrap/version policy, session/model setup,
subscription lifecycle, interaction forwarding, and live interface tests.
Private workspace exports do not establish external SDK stability.

[source]: https://github.com/apache/maka/tree/a96de5e2f77952b00ba163ad4419cd31543f22bb
[backend]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/core/src/session.ts#L331-L352
[factory]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime/src/model-factory.ts#L104-L142
[external]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/core/src/external-session.ts#L160-L180
[host-package]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/package.json
[runtime-package]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime/package.json
[cli-package]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/cli/package.json
[connection]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/client/connection.ts#L101-L331
[manager]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime/src/session-manager.ts#L2006-L2016
[driver]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/cli/src/runtime-host-session-driver.ts
[desktop]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/apps/desktop/src/main/runtime-host-client.ts#L1352-L1362
[turn]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/protocol/turn.ts#L53-L351
[subscription]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/protocol/session-continuity.ts#L95-L123
[switch]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/cli/src/runtime-host-session-driver.ts#L723-L803
[import]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/protocol/external-session.ts#L76-L105
[branch]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/protocol/session-revision.ts#L30-L96
[feature]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/server/execution-composition.ts#L1056
[candidate]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime/src/session-manager.ts#L2100-L2241
[validation]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/protocol/turn.ts#L540-L582
[admission]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/server/root-turn-coordinator.ts#L1921-L2236
[resume-driver]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/cli/src/runtime-host-session-driver.ts#L489-L519
[concurrency]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/__tests__/execution-host-continuation.test.ts#L32-L111
[availability]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/server/host-session-availability.ts#L56-L77
[catalog]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/protocol/session-catalog.ts#L151-L189
[subscription-client]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/client/session-subscription.ts#L64-L87
[protocol-tests]: https://github.com/apache/maka/blob/a96de5e2f77952b00ba163ad4419cd31543f22bb/packages/runtime-host/src/__tests__/protocol.test.ts#L1355-L1479
