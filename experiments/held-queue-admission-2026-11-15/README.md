# Held queue admission and input ownership

Date: 2026-11-15. Linux x64, synthetic providers and controlled transports.
No real account or model service was used. The change belongs to the session
drivers and record folds: a host can now use the records to tell whether an
adapter-held input still occupies the session, including before native start.

## Result and host-visible changes

Claude, Qoder, Qwen and Cursor now answer `queue()` with
`accepted, queued: "adapter"`. At dispatch they record a new `prompt`
request whose `carries` names the original input. That request has its own
single response. The input remains one conversation input; the extra request
does not mean that its text was sent twice. Stream-json writes retain the
original native input UUID.

Two admission changes are intentional:

- After a queued input is sent but before native execution starts, a new
  `prompt()` returns `busy`. Previously the stream-json idle-send path left
  this interval open.
- An accepted interrupt does not dispatch the next held input. The driver
  waits for the native run to end or for its cancellation receipt. Previously
  a prompt sent through that idle-send gap could advance on interrupt
  acceptance alone.

The queue reservation keeps status running across terminal observers.
Reentrant request attempts do not replace the accepted queue owner's
identity. Live status, views, replay and checkpoints preserve the same
reservation. Native start and completion facts still come from native frames.

## Refusal and unresolved sends

An explicit Cursor SDK send refusal adds request-scoped `input_dropped` to
the existing `cursor/send_rejected` frame, returning ownership before the
next dispatch. A queued send that has not returned after 60 seconds remains
unanswered and occupied. OAR does not resend it or automatically cancel a
late run. A late run is adopted normally; only host `abort` or `dispose`
requests cancellation. The queue caller already received ownership
acceptance, so no new public result variant is needed for this internal
dispatch. Ordinary Cursor `prompt()` still has its previous 60-second
timeout and late-run cancellation; that separate behavior is not changed.

A thrown stream-json write retains withdrawable input ownership, without
automatic retry or a fabricated native refusal. Release and process exit
inside a dispatch-request observer prevent the subsequent write.

## Reproduction and regression evidence

The reproducible controls are checked-in tests:

- [Four-adapter records and replay](../../tests/adapter-held-queues.test.ts):
  one logical input, queue and dispatch responses, every-prefix checkpoint
  replay, original UUID, reentrant carried requests and acceptance-observer
  withdrawal.
- [Transport and observer boundaries](../../tests/adapter-held-queue-boundaries.test.ts):
  FIFO, release, process exit, thrown writes and synchronous duplicate-input
  refusal before dispatch acceptance.
- [Cursor controlled SDK](../../tests/cursor/cursor-held-queues.test.ts):
  actual SDK rejection, sends delayed beyond 60 seconds, late run adoption,
  explicit abort/dispose and immediate completion. These establish OAR's
  handling, not real Cursor backend timing or delivery.
- [Native input identity](../../sea-trial/vendor/input-identity.vendor.test.ts):
  Claude's steer fallback has three attempts (`steer`, `queue`, `prompt`),
  one logical input and one native acknowledgement. The carried request
  names the same input. Codex retains its two-attempt fallback.

The first eight record/observer controls all failed against the old
implementation. The first full unit run then found two existing tests that
expected the old admission gaps. Their replacements assert native end and
cancellation boundaries in
[withdrawal](../../tests/claude/claude-session-withdraw.test.ts) and
[cancellation observation](../../tests/stream-json/cancellation-observation.test.ts).
The first Claude vendor run passed 85 cases and failed the old two-attempt
fallback count. After replacing it with the full attempt sequence plus
unique-input and carries assertions, the targeted suite passed all three
Claude cases and both Codex cases. Original failure logs are retained.

Run the focused controls with:

```sh
CI=1 pnpm vitest run tests/adapter-held-queues.test.ts tests/adapter-held-queue-boundaries.test.ts tests/cursor/cursor-held-queues.test.ts tests/claude/claude-session-withdraw.test.ts tests/stream-json/cancellation-observation.test.ts
CI=1 OAR_TEST_REQUIRE_AVAILABLE=1 OAR_TEST=claude-aimock pnpm vitest run sea-trial/vendor/input-identity.vendor.test.ts
CI=1 OAR_TEST_REQUIRE_AVAILABLE=1 OAR_TEST=codex-aimock pnpm vitest run sea-trial/vendor/input-identity.vendor.test.ts
```

## Native observations

The behavior runs used the CI-pinned Claude 2.1.325, Qoder 1.1.81 and
Qwen 0.27.3 binaries. All three retained the original input identity:

| Backend | Queue / acceptance seq | Dispatch / acceptance seq | Native-start frame seq |
| --- | --- | --- | --- |
| Claude | 4 / 5 | 19 / 20 | 23 |
| Qoder | 9 / 10 | 20 / 21 | 25 |
| Qwen | 5 / 6 | 16 / 17 | 18 |

[Selected records](selected-records.json) contain only the five cited
records per backend, with source-file fingerprints. The Qwen synthetic
project path is redacted. These excerpts omit intervening frames and are
not complete replay inputs. Claude and Qoder's native `command_lifecycle`
names the original UUID. Qwen's `system/init` has no native input UUID;
its `turn_active.inputId` is OAR's existing attribution to the written input.

All 16 default behavior backends and the separate Antigravity behavior run
passed on Linux. The cross-runtime set used Codex 0.169.0, DSH 0.2.1-rc.5,
OpenCode 1.19.5, Grok 1.0.70, Kimi 2.4.1, CodeBuddy 2.179.3, Antigravity
1.5.0, Factory 1.12.1 and the repository's bundled Pi versions, alongside
the three versions above. Qoder vendor checks passed 16 cases and Qwen
vendor checks passed 21. After rebasing onto main `ed69f351`, the final
`CI=1 pnpm run check` passed typechecking, lint, 4,370 unit tests and 18 mock
behavior cases. Full raw traces and original failures remain in the author
workspace.

For a repeat run, install the versions pinned by the current CI workflow,
set the corresponding `OAR_<RUNTIME>_BIN` paths, and run:

```sh
CI=1 OAR_TEST_REQUIRE_AVAILABLE=1 pnpm tsx sea-trial/all.ts
CI=1 OAR_TEST_REQUIRE_AVAILABLE=1 OAR_TEST=antigravity-aimock pnpm sea-trial
CI=1 OAR_TEST_REQUIRE_AVAILABLE=1 OAR_TEST=claude-aimock pnpm vitest run sea-trial/vendor
CI=1 OAR_TEST_REQUIRE_AVAILABLE=1 OAR_TEST=qoder-native pnpm vitest run sea-trial/vendor
CI=1 OAR_TEST_REQUIRE_AVAILABLE=1 OAR_TEST=qwen-aimock pnpm vitest run sea-trial/vendor
CI=1 pnpm run check
```

This observation is Linux-only. The PR's native CI jobs provide the
cross-platform check; they are not replaced by these local observations.
