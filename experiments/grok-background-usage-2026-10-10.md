# Grok background usage: 2026-10-10

OAR now counts the root's automatic follow-up after a background subagent
finishes. It still cannot safely add a late child's own bill: the native
stream does not establish whether the parent already included it.

## Native observations

`grok 1.0.50 (c58f321264ba) [stable]`, Linux, isolated home, scripted local
provider with a dummy key. No account or model quota was used. Run:

```sh
pnpm tsx experiments/grok-background-usage.ts
```

The provider bills the root's first two calls 1000/20 and 1100/3 tokens,
the child's call 700/7, and each subsequent root call 10/1. The probe
controls the two background completion orders with provider barriers,
then sends one more ordinary root prompt after the automatic follow-up.
Numbers below are input/output tokens.

| Execution | `will_wake` | First root prompt ledger | Automatic root follow-up | OAR total before fix | OAR total after fix |
| --- | --- | --- | --- | --- | --- |
| Foreground child | false | 2800/30, includes child | None | 2810/31 | 2810/31 |
| Background child finishes before parent | true | 2800/30, includes child | 10/1 | 2810/31 | 2820/32 |
| Background child finishes after parent | true | 2100/23, excludes child | 10/1 | 2110/24 | 2120/25 |

The last row still omits the child's 700/7. A later ordinary prompt adds
only its own 10/1; it does not recover that child bill. In both background
runs `will_wake` is true, so that flag cannot decide whether child usage
is already in the root total. The older foreground evidence established
overlap, not complete coverage of background work.

The [checked-in native frames](../tests/replay/fixtures/grok-background-usage.json)
retain the three runs' prompt replies and vendor lifecycle/terminal
notifications, with session ids normalized and disposable paths removed.
The [adapter replay test](../tests/grok/grok-spontaneous-usage.test.ts)
delivers each notification twice and compares live totals with JSON replay
through `usageOf` and `viewOf`. Replayed wake reports during both resume
and load remain native-only, even on the live notification method. Ordinary
and child terminal ledgers are not added a second time.
The [boundary tests](../tests/grok/grok-spontaneous-usage-edges.test.ts)
also cover incomplete reports, unknown owners, pre-bind delivery, cache
parts, zero totals and a new native report reusing a wake prompt id.

## Why the root follow-up is independent

The public Grok source inspected was commit
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; this is not asserted to be the
binary's build commit. Its behavior agrees with the recorded runs:

- [`inject_subagent_completed_prompt`][wake] sends `SessionCommand::Prompt`
  directly to the parent actor with id `subagent-completed-<child>`. It
  bypasses ACP `session/prompt`, so there is no RPC answer for OAR to bill.
- The [terminal notification][terminal] carries that prompt's usage. The
  ordinary [ACP answer][answer] likewise uses its own prompt result, not a
  session-wide total. The follow-up ledger is therefore independent.
- [Notification emission][notification] persists and forwards the same
  native event id. OAR counts each root follow-up `_meta.eventId` once,
  retaining duplicate native frames without another usage event. A later
  wake of the same child may reuse the prompt id, so the prompt id alone
  is not the deduplication key.

OAR's accumulator is shared between prompt replies and independent root
notifications. A later ordinary reply cannot overwrite the follow-up's
contribution. Missing event identity, ownership or either token side
leaves a notification native-only rather than inventing a ledger.

Opening can replay old notifications. OAR starts counting only after the
native `session/new`, `session/resume` or `session/load` success answer arrives,
before any subsequent model/effort configuration. The SDK routes notifications
through asynchronous handlers, so an older notification can reach the recorder
after the open-answer callback. A first callback-based gate passed once but
failed on repeat; that failure is retained in the local validation artifacts.
OAR now captures each notification's phase on the decoded wire stream, before
SDK routing or recorder buffering, without changing the message. Deterministic
regressions deliver old notifications after the open callback and fresh ones
before recorder binding. Recognized old identities exclude late duplicates.
Explicit native `isReplay: true` reports also stay native-only.

Grok 1.0.50 advertises resume and OAR prefers it, without retrying failures
as load. If the resume capability is absent, OAR instead selects load.
Lookout's independent native check found no historical terminal replay on
resume, but four terminal reports including the old wake on direct load.
Those load reports used `_x.ai/session/update`, whereas live reports used
`_x.ai/session_notification`. The opening gate deliberately does not depend
on that method-name difference. The adapter regressions replay history on
the live method to verify the boundary.

## Why child accounting remains partial

[`record_subagent_usage`][child-usage] includes the child in the prompt
ledger only when its pinned parent prompt matches the current prompt.
Otherwise it applies the usage only to Grok's session ledger. The
acknowledgement confirms processing in either case; it does not identify
which ledger was used.

The child [waits for that acknowledgement][ack] before its completion
callback, but [completion presentation runs on another worker][worker].
The parent can finish between applying the child usage and emitting the
child completion notification. Notification order cannot prove accounting
inclusion. `will_wake` instead follows the [automatic-wake conditions][gate].

OAR keeps child ledgers native-only and does not derive an extra
`withChildren` total from them. Adding a child's bill based on a tool
argument, `will_wake` or observed notification order could double-count.
The runtime page and public usage comments now state this limit.

[wake]: https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/subagent/spawn.rs#L493-L568
[terminal]: https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn_end.rs#L330-L418
[answer]: https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L1742-L1761
[notification]: https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/updates.rs#L1015-L1071
[child-usage]: https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/updates.rs#L149-L199
[ack]: https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/subagent/attempt_runner.rs#L286-L323
[worker]: https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/subagent/spawn.rs#L281-L317
[gate]: https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/subagent/spawn.rs#L386-L474
