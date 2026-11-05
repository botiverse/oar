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
| Extension starts EXT while B is being admitted | RPC runs B's hook, refuses B, silently loses it and clears EXT's gate. SDK defers B until after EXT. | Preserve EXT; record RPC's drop and do not repeat the hook. Keep SDK's different native result. |
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
  is added. An inputId wait binds the attempt at its cursor.
- `awaitIdle` resolves with null when handling leaves no remaining work; it
  still waits for EXT or accepted queued input. An already-handled prompt
  does not abort EXT because the caller's signal or timeout fired.
- Hosts reading events can handle `input_handled` and request-referenced
  `input_dropped`. Pi ordinary prompt records now also include the optional
  admission field, and queue dispatch exposes its existing `carries` contract.
  The shared behavior assertions still compare the host payload exactly,
  separately validating the declared optional admission field.
- CLI JSON output for handled input is `{ disposition: ... }`; it does not
  print a fabricated completed outcome. Arena and repository examples handle
  the new arm explicitly.

Pi Durable and the existing restriction on synchronously submitting from an
ordinary terminal observer are unchanged. The latter remains documented in
`record-stream.md` and `manual-compaction.md`; this change fixes handling and
refusal ownership, not that separate native settlement window.

## Reproduction and validation

```sh
CI=1 pnpm exec vitest run tests/input-handled.test.ts tests/pi/pi-turn-preflight.test.ts
OAR_TEST=pi-aimock CI=1 pnpm exec vitest run sea-trial/vendor/pi-input-handled.vendor.test.ts
OAR_TEST=pi-rpc-aimock CI=1 pnpm exec vitest run sea-trial/vendor/pi-input-handled.vendor.test.ts
```

For the explicit RPC floor, set `OAR_PI_RPC_COMMAND` to a separately installed
Pi 1.4.0 executable and use `pi-rpc-aimock`. Clear an inherited
`PI_PACKAGE_DIR`: it changes native resource lookup and is not fixture input.
The tests install native input extensions in an isolated agent directory.

Seven native cases pass on each of SDK 1.5.0, RPC 1.5.0 and RPC 1.4.0.
Fourteen pure fold/helper cases and 34 controlled Pi cases pass, including
full StatusState, task status and session-view checkpoints at every prefix,
legacy logs, absent IDs, reused IDs, foreign/child receipts, cancellation,
disposal, FIFO, and deferred SDK fulfillment. Full native vendor suites pass
with 108 SDK and 106 RPC cases; the explicit floor's handling, preflight and
admission subset passes 11 cases. All 14 shared behavior backends pass.

Nine targeted mutations fail the relevant assertions: lose the native
reservation; accept another request's handling; retain provisional view
identity; borrow an unrelated end; retain handled SDK admission; omit RPC
correlation; allow a new prompt past held input; remove the queue acceptance
barrier; and accept SDK fulfillment before preflight. No replay snapshots
were updated. Full check (3,233 tests and 18 mock behavior cases), build and
clean packed-consumer validation passed on base `4fd225c8`. Cross-platform
native results remain for the PR's CI.
