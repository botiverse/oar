# Codex idle queue admission

Observed on Linux with Codex 0.169.0, November 16, 2026. The real app-server
uses a fresh temporary home and a loopback aimock provider. No account or
paid model is used. This tests one loaded root thread, not unloaded or
resumed threads.

## Observations

[Selected evidence](selected.json) retains the queue replies, inspection
results, native turn completions, and the full raw evidence fingerprint.

- After normal completion, three consecutive `thread/queue/add` calls each
  started their own turn without another prompt. The start was observed
  within 28 to 30 ms in the first run, with a 20 ms polling resolution.
  These are observation bounds, not a latency guarantee. The selected
  second run records its own timing values.
- Each accepted submission retained the supplied `clientUserMessageId`;
  its queue entry disappeared and its turn completed.
- After a held provider request was interrupted and the native
  `turn/completed` reported `interrupted`, `queue/add` accepted another
  submission. No turn started during the next 10 seconds, and
  `queue/list` still returned that exact submission and client ID.
- The next explicit `turn/start` ran its new prompt first. After it
  completed, the previously parked submission ran. The final queue was
  empty. The provider observed `A_wake` before `A_afterinterrupt`.

## Source and decision

The exact native source is tag `rust-v0.169.0`, commit
`d32063f96c2dff1dc96af839b3952abb6acfeda4`:
[queue service](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/ext/queue/src/service.rs).
`enqueue_with_metadata` saves the submission and calls `wake_if_loaded`.
The latter skips `AgentStatus::Interrupted`; `on_thread_idle` also skips
the interrupted cause. `dispatch_if_idle` starts and removes the oldest
queued input. The 10-second observation alone cannot prove an indefinite
wait; these native guards explain the observed difference.

OAR keeps native queuing after normal completion. After an observed root
interruption, it refuses a new queue request with `no_active_turn` until a
new native root turn starts, directing the host to `prompt`. It does not
claim accepted input is about to run, nor translate queue into prompt.
Child events do not change this guard. Already accepted native queue
entries are unaffected. A stale running status in `deliver()` still
returns the steer-to-queue refusal honestly.

## Reproduction and validation

```sh
OAR_CODEX_BIN=/path/to/codex-0.169.0 pnpm tsx experiments/codex-idle-queue.ts /tmp/codex-idle-queue-evidence
OAR_TEST=codex-aimock OAR_CODEX_BIN=/path/to/codex-0.169.0 CI=1 pnpm vitest run sea-trial/vendor/codex-idle-queue.vendor.test.ts
```

The experiment retains full calls, notifications, provider requests and
waits in `evidence.json`, even on an observation failure. Native regression tests cover
automatic queue startup after normal completion, refusal after
interruption, and queuing after a later prompt. Transport tests cover
root/child distinction and a forced stale running status through the real
`deliverInto` implementation.

The first vendor-test setup used invalid non-UUID OAR input IDs and failed
before admission; that preparation failure is not a runtime defect. With
valid IDs, the normal-completion test passed and the interrupted test
failed because the old adapter returned `accepted`. After the adapter
fix, both native tests and the transport suite passed (23 tests).

Final validation: `CI=1 pnpm run check` passed (4,434 unit tests and 18
mock behavior cases). Codex 0.169.0 behavior passed 16 cases, with 3
capability skips; both native queue regressions passed again on the final
implementation. The first full check found lint issues in the new code
and tests; these were corrected before the passing complete run.
