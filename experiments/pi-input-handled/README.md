# Pi native input disposition

November 5, 2026. Pi SDK 1.5.0, RPC 1.5.0 and explicit-command RPC 1.4.0,
Linux x64, Node 24.19.0. All model requests used a loopback aimock provider;
no real account or external inference was used. Pi Durable is outside this
change. Source identities are in [source-hashes.json](source-hashes.json).

A native `handled` receipt ends admission of that input. It does not prove a
successful handler or finish a model run. Recording this distinction lets a
host stop waiting or resending while retaining independently started work.
The adapter owns native correlation; shared folds and helpers read the records.
The committed native tests are the reproduction and regression artifact.

## Baseline and native controls

Baseline `5e6658deb5c1dbd48117467558e104a457cba945` includes the Pi preflight
repairs in PR #617. Six native observations per execution/version combination
reproduced these boundaries; [baseline.json](baseline.json) retains selected
results. The original observation tests asserted the defects, not the repair.

| Native case | Baseline observation | Required result |
| --- | --- | --- |
| Input extension handles `HANDLE` | SDK stays busy; RPC admits another prompt while status remains running. Neither makes a model request or emits a turn end. | Record handled, become idle, permit the next prompt. |
| A runs, held HANDLE then C | SDK strands C; RPC drains it but supplies no handling record. | One logical HANDLE input, no fake turn, C runs. |
| Extension starts EXT while B is being admitted | RPC runs B's hook, refuses B, silently loses it and clears EXT's gate. SDK defers B until after EXT. | Preserve EXT; record RPC's refusal without repeating the hook. SDK waits for the owning prompt promise, preserving A → EXT → B. |
| `/spawn` starts EXT and is handled | EXT inherits the command's provisional input identity. | Keep EXT active with its own content and no command `openedBy`. |
| A runs while steer is handled | Native handling neither ends nor replaces A. | Resolve only the steer attempt; preserve A's identity and gate. |
| `/fail` handler throws | Native still reports handled; no model turn exists. | Keep the handler error separately; handled is not completed. |

An additional implementation control makes `/spawnwait` wait for EXT to end
and then delay its handling receipt. It exposed two distinct bugs: idle status
while the handler still owned admission, and an input-scoped wait borrowing
EXT's completion. The closed view turn also retained the command attribution.
The regression now checks the interval before the receipt as well as the final
result, output and independent outcome. It passes on all three combinations.

## Record and ownership changes

- `input_handled { requestId, inputId? }` is emitted only on native handling
  evidence. SDK uses the invocation's `preflightResult` callback or steer
  result; RPC retains its original response and command ID. `responseTo`
  accepts exact per-invocation callback correlation as well as native IDs.
- SDK handler errors are captured through the initial `bindExtensions`
  `onError` callback. RPC keeps its native error event. Neither changes the
  accepted delivery into a successful model turn.
- Native refusal after queue acceptance emits request-correlated
  `input_dropped { reason: "runtime_refused" }`. Direct refusal stays a
  rejected control. Input hooks are never automatically retried.
- Pi's held queue uses `queued: "adapter"`; dispatch is a prompt with
  `carries` referring to the original input. New prompts and compaction
  cannot overtake held input, including in synchronous refusal/handling
  observers. Queue acceptance is recorded before dispatch.
- Native activity and each pending admission have separate ownership. SDK
  prompt fulfillment alone cannot accept a deferred input; its native
  preflight callback must arrive. Late old failures and handling receipts
  cannot release another input or extension run.

**Additional control fact:** Pi prompt records carry `admission: "native"`.
It is not an `InputOptions` setting or a native payload alteration. It states
that this invocation requires its own admission evidence. Without it, an
independent EXT run ending before `/spawnwait`'s receipt is indistinguishable
from the existing fallback interpretation of old prompt records. The marker
keeps that input reserved until its correlated start, acceptance, handling or
refusal; an unrelated turn end retains its own outcome. Old records without
the marker or disposition keep their prior interpretation.

The full public `StatusState` checkpoint retains both admission and underlying
native state. Incremental consumers must continue saving that complete value
with the cursor. `AgentStatus` remains the display value. Conversation attempts
retain handled disposition separately from accepted delivery; views remove
only provisional attribution, including a late receipt after inputId reuse.
No independent output or native outcome is removed.

## Helpers and release notes

This is a public type change for the minor release after 0.88.0:

- `promptAndWait` adds `kind: "handled"`, with the accepted control and
  handling evidence. Exhaustive `PromptRun.kind` switches must handle it;
  code that reads `outcome` after excluding only `rejected` must also exclude
  `handled`. Handling is not a success outcome and carries no borrowed text.
- Only the input-scoped `awaitTurnEnd` and `turnEndAfter` overloads widen to
  `TurnOutcome | InputHandled` (plus the lookup's existing null). Unscoped
  next-turn waits keep their types and behavior. No public request selector
  is added. An inputId wait binds the live attempt at its cursor; a cursor after
  disposition binds the next attempt. Accepted queue withdrawal returns
  `aborted`, and rejected dispatch returns `failed` even without a native
  drop. These corrected waits also apply to older ACP adapter-queue logs;
  they do not invent native turn ends.
- `awaitIdle` resolves with null when handling leaves no remaining work; it
  still waits for EXT or accepted queued input, and resolves when the final
  held input is refused. A provisional prompt rejected before a turn exists
  (including `busy`) and standalone manual compaction both resolve it with
  null. Accepted withdrawal resolves input-scoped waits with `aborted` for
  every runtime, including native queues, without a fabricated turn end.
  These cases previously could leave waits pending. It follows root status
  rather than retaining the original turn's input identity. An already-handled prompt
  does not abort EXT because the caller's signal or timeout fired.
- Hosts reading events can handle `input_handled` and request-referenced
  `input_dropped`. Its `inputId` is now optional: consumers must also accept a
  request ID identifying an input with no supplied logical ID. Pi ordinary
  prompt records now also include the optional
  admission field, and queue dispatch exposes its existing `carries` contract.
  The shared behavior assertions still compare the host payload exactly,
  allowing the admission field only on Pi SDK/RPC. `SessionView.statusState`
  is available to every runtime when the fold needs additional correlation.
- An abort accepted during Pi preflight applies only to a run that starts
  before the handling/refusal receipt and is consumed once. An extension run
  starting after `handled` needs a new abort after `turn_active`; SDK no longer
  cancels it through the stale marker retained by older versions.
- SDK holds queued inputs until its prompt promise finishes, including
  settlement-time extension actions. A run whose `agent_start` preceded
  subscription still ends on native settlement when later run events exist;
  idle custom-message notices are not run evidence, and no-evidence settlement
  invents neither completed nor aborted. A queued command's detached EXT
  launch can still lose the next native slot with an observable extension
  error; the SDK barrier covers awaited settlement actions, not detached
  work after a handled receipt. RPC can lose either the held input or EXT
  according to which wins admission. These limits are documented in pi.md.
- CLI JSON output for handled input is `{ disposition: ... }`; it does not
  print a fabricated completed outcome. Arena and repository examples handle
  the new arm explicitly.

Pi Durable and the existing restriction on synchronously submitting from an
ordinary terminal observer are unchanged. The latter remains documented in
`record-stream.md` and `manual-compaction.md`; this change fixes handling and
refusal ownership, not that separate native settlement window.

## Reproduction and validation

```sh
CI=1 pnpm exec vitest run tests/input-handled.test.ts tests/input-disposition-waits.test.ts tests/pi/pi-turn-preflight.test.ts tests/pi/pi-admission-failures.test.ts
OAR_TEST=pi-aimock CI=1 pnpm exec vitest run sea-trial/vendor/pi-input-handled.vendor.test.ts
OAR_TEST=pi-rpc-aimock CI=1 pnpm exec vitest run sea-trial/vendor/pi-input-handled.vendor.test.ts
OAR_TEST=pi-aimock CI=1 pnpm exec vitest run sea-trial/vendor/pi-settlement-admission.vendor.test.ts sea-trial/vendor/pi-system-prompt.vendor.test.ts
OAR_TEST=pi-rpc-aimock CI=1 pnpm exec vitest run sea-trial/vendor/pi-settlement-admission.vendor.test.ts sea-trial/vendor/pi-system-prompt.vendor.test.ts
```

For the explicit RPC floor, set `OAR_PI_RPC_COMMAND` to a separately installed
Pi 1.4.0 executable and use `pi-rpc-aimock`. Clear an inherited
`PI_PACKAGE_DIR`: it changes native resource lookup and is not fixture input.
The tests install native input extensions in an isolated agent directory.

Native controls cover SDK 1.5.0, RPC 1.5.0 and the explicit RPC floor.
In addition to handling, preflight cancellation and compaction refusal, the
SDK tests hold A/BOOT, then queue B while settlement sends EXT with fast and
150 ms input hooks. Both the adapter-owned and independent-run variants must
reach the model in A/BOOT → EXT → B order. Another control subscribes after
BOOT's agent_start and checks its visible text, terminal outcome and awaitIdle.
Both paths verify that handling clears cancellation before a later EXT run.

Controlled regressions cover final-queue refusal, withdrawal and rejected
dispatch without drop frames, legacy untracked drops, attempt reuse, cancellation
consumed before a second independent run, and the RPC deadline measured from
actual abort delivery. Started receipts without any run evidence cannot
fabricate completed or aborted, and provisional prompt rejection returns null
from awaitIdle rather than claiming a failed turn.

A synthetic ancestor CLAUDE.md control confirmed that native context survives
prompt replacement. The exact prompt snapshot now creates its working directory
under Node's OS default temporary directory with TMPDIR/TMP/TEMP overrides
removed case-insensitively inside the path-query child after it starts.
Runners can put their configured temp directory inside an agent
checkout. Both SDK and RPC are checked with such an inherited directory. The
expected prompt and compaction assertions remain unchanged. Reverting to the
configured temporary directory makes both native snapshots fail with the
synthetic project context. The working directory is also canonicalized before
opening either execution path: the preceding macOS CI run failed solely on
its symlink spelling in this snapshot, with 109 other vendor cases passing.
The [original failing job](https://github.com/botiverse/oar/actions/runs/42033856458/job/127266796761)
is retained; this is separate from the ancestor-context failure. The next
[Windows job](https://github.com/botiverse/oar/actions/runs/42049301862/job/127320754447)
passed all 114 other vendor cases, including the six new settlement controls,
but its snapshot still contained the synthetic ancestor. Removing all case
spellings before spawn did not fix the [following Windows run](https://github.com/botiverse/oar/actions/runs/42050450407/job/127324844307).
Node 24.22.2's bundled [libuv Windows process implementation](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/win/process.c#L47)
restores a missing TEMP from the parent. The fixture therefore clears overrides
inside the path-query child before calling Node's tmpdir. Linux hostile-temp
controls pass; the final Windows correction awaits CI.
That run also retained a separate [Windows CodeBuddy installation timeout](https://github.com/botiverse/oar/actions/runs/42050450407/job/127324844350)
after its unit, mock and build steps passed. Its installer test and 180-second
deadline are unchanged; the log does not establish a cause.

| Review boundary | Committed regression |
| --- | --- |
| Abort while a command waits to start EXT; RPC timer starts only at delivery | `pi-admission-failures.test.ts`, native `/spawndelay` case |
| SDK delayed prompt refusal belongs to B, not A; C is not stranded | `pi-admission-failures.test.ts`, native settlement-compaction case |
| Last held input is dropped; awaitIdle resolves | `input-disposition-waits.test.ts` |
| Withdrawal or valid dispatch rejection without drop settles scoped waits | `input-disposition-waits.test.ts`, with invalid-carry negative control |
| Legacy untracked drops and cursor after retired attempt | `input-disposition-waits.test.ts` |
| Started receipt settles or rejects without native agent_start | `pi-admission-failures.test.ts`, no fabricated completed outcome |
| RPC queue acceptance precedes observer-triggered dispatch | `pi-turn-preflight.test.ts` |

The first review revision checked sixteen targeted reversions against these
regressions. The initial
SDK unstarted-settlement reversion survived because a later promise rejection
also cleaned up; an additional successful-promise/no-agent-start case closes
that gap. The RPC acceptance barrier now has a terminal-observer queue case
that fails when the guard is removed. The prior report's acceptance-barrier
mutation applied only to SDK, not RPC; it did not prove both implementations.

Second review validation on base `74839802` passed full check (3,266 tests
and 18 mock behavior cases), build, clean packed-consumer installation, all 14
behavior backends, full native vendor suites (115 SDK / 109 RPC), and the
15-case RPC 1.4.0 subset. Nine targeted reversions failed their regressions,
including the requested N15, N16, N18 and M2 boundaries, missed-start and
no-evidence settlement, response ordering, provisional rejection, and the prior
SDK implementation against the new native controls. Two additional fixture
reversions proved the hostile-temp-directory tests detect ancestor context.
Selected outcomes are in [review2-validation.json](review2-validation.json).
Existing replay snapshots and the expected system prompt were unchanged.
Windows and macOS results remain for the revised pull request's CI.

Third review isolates custom-message notices from run evidence. Real SDK 1.5.0
controls reproduce the idle command, timer and handled-input-hook deadlock when
the filter is removed. A fourth control queues a non-triggering custom notice
inside `before_agent_start`, then deliberately supplies an invalid extension
tool loadout. Native `_prepareRun` fails and flushes that notice; the fixed
adapter records the failure and still accepts the next prompt. The same four
controls run on RPC 1.5.0 and the 1.4.0 floor. Controlled SDK/RPC settlements
with no start evidence invent neither completed nor aborted after a notice.

The bootstrap native control now tries a new prompt while BOOT emits text:
status is running and admission must report busy. This catches B7 without
losing the legitimate BOOT end or A/BOOT → EXT → B ordering. Four controlled
queue regressions separately delay the owning prompt's completion and the
independent native idle wait, including a run that began before subscription
and a handover from an owned prompt. B1, B3, B4, B5 and B6 all fail those FIFO
assertions when reverted; they are not equivalent mutations. Restoring custom
message start/end as run evidence fails all four new native controls and the
no-start settlement checks. Selected outcomes are in
[review3-validation.json](review3-validation.json).

Third review validation passed full check (3,276 tests and 18 mock behavior
cases), build, clean packed-consumer installation, all three Pi behavior
backends, full Pi 1.5.0 vendor suites
(119 SDK / 113 RPC), and 19 focused RPC 1.4.0 cases. This revision changes only
Pi run-evidence classification, its regression tests and documentation; the
previous round's all-backend validation remains separate above. The
system-prompt correction still needs the new Windows/macOS CI results.

Simultaneous accepted queue entries sharing one inputId remain outside this
repair: their second dispatch can be refused by carries validation, without a
native drop receipt. The input contract already prohibits resubmitting an
accepted logical input; use separate IDs for distinct inputs and retry only
after ownership returns. No automatic replay was introduced.

A synthetic mixed root/child log can briefly lose the root's provisional
status after an independent root run ends while native admission is pending.
Pi SDK/RPC emit only root events, so their current native streams cannot reach
this case; no claim of repaired generic child-event admission is made here.
