# Runtime version check: 2026-11-02

## Manual compaction controls

The first implementation exposes optional `Session.compact()` on Claude,
Codex and Pi SDK/RPC. It requests native compaction and waits for its own
completion evidence. All four reject an active turn: Pi and Codex can
otherwise replace current work, while a queued Claude slash command can
change meaning before execution. The host explicitly aborts or waits when
it wants that transition.

`Runtime.manualCompaction` distinguishes supported, explicitly unsupported,
and undeclared entries. The [contract](../docs/spec/manual-compaction.md)
defines results, queue behavior and observation limits. OAR neither
summarizes the conversation nor opens a replacement session.

## Native controls

Linux x64, isolated configuration and scripted local providers; no account
quota. Versions were selected explicitly, rather than taken from PATH:

| Entry | Tested version | Result and completion evidence |
|---|---|---|
| Claude | 2.1.316 | Same-process built-in command provenance, matching command lifecycle, manual `compact_boundary`, then matching result |
| Codex | 0.166.0 | `thread/compact/start`, root turn identity, started/completed `contextCompaction` item identity, matching completed turn |
| Pi SDK | 1.4.0, 1.5.0 | Native `compact()` with manual start/end events |
| Pi RPC | 1.4.0, 1.5.0 | Native `compact` request with manual start/end events |

The [vendor regression](../sea-trial/vendor/manual-compaction.vendor.test.ts)
runs eight controls on each entry and a ninth on Claude:

1. Create with old system/append instructions, resume with new instructions,
   compact, require native completion, and inspect the next provider request
   for the new markers with both old markers absent.
2. Hold the summarization response, expire the caller's wait, and require
   `unconfirmed`, continuing compacting status, and refusal of another
   prompt/compact. Later native completion still enters the record stream.
3. Repeat with an aborted observation signal. It stops the wait only.
   Claude/Pi retain a later queued input; Codex refuses it `busy`.
4. Dispose while summarization is held. Observation ends as unconfirmed,
   with no synthetic compaction terminal frame, including after transport
   rejection. Any real native aborted frame remains observable.
5. Return a native provider failure. The operation fails and a subsequent
   normal input can run after native settlement.
6. Request compaction during a held ordinary reply. It is refused and the
   original reply finishes normally.
7. Abort while summarization is held. Require native cancellation control
   acceptance, preserve the native compact outcome, and complete a later input.
8. Call with an already aborted signal. Require `rejected / aborted` and no
   additional provider request, with the session still idle.
9. Claude only: install a project `compact` command. Refuse compaction before
   invoking that command or making another provider request.

All 33 controls passed locally. Claude's failure control found an important
distinction: `system/status.compact_result: "failed"` can be followed by an
ordinary result with `is_error: false`. The compaction result retains the
native failure instead of treating that ordinary success as completion.
The same distinction applies to interrupt during summarization: Claude stops
the work but reports `compact_result: failed`, so `compact()` retains
`failed / native_failed`. The ordinary `turn_ended: aborted` reflects OAR's
existing turn cancellation convention and is a separate fact. A queued
Claude command with native `cancelled` settles as `aborted`. Codex and both
Pi entries report native aborted compaction in the held-summary control.
No error-text matching is used.

Codex's regression exercises local compaction. ChatGPT-login remote
compaction was not exercised. Earlier 0.163 source inspection found both
paths using `build_compaction_replacement_history`; this source observation
does not establish a live remote result. The declaration and runtime page
retain that limit.

Early local runs also passed on older executables found on PATH. They are
not the evidence for the version rows above: all four supported entries
were rerun with the stated versions. Windows/macOS results belong to the
pull request's native CI jobs and were not available when writing this
local report.

## Claude command provenance

[`claude-command-origin.ts`](manual-compaction/claude-command-origin.ts)
reproduces the unsafe queued case. While an ordinary provider response is
held, same-process `initialize` reports built-in `compact`. The probe queues
`/compact`, adds a project command and invokes native `reload_skills` before
releasing the ordinary response. Claude reports `commands_changed` and runs
the project prompt, with zero compaction boundaries. The
[selected result](manual-compaction/claude-command-origin.json) retains only
version, provenance and observed outcome, excluding initialize account data.

[`claude-initialize-effects.ts`](manual-compaction/claude-initialize-effects.ts)
checks the safety of reading this catalog after a session is configured.
After an ordinary turn and a change to `plan` permission mode, it sends three
more `initialize` requests. On Claude 2.1.316, SessionStart stays at one
invocation, the HTTP MCP server stays at one initialization, `get_settings`
is unchanged, the next native init still reports `plan`, and the next
provider request has the same system/append instructions and tool catalog.
The [selected result](manual-compaction/claude-initialize-effects.json)
contains these assertions and counters, without account data or paths.
This is a Linux observation of that version, not a claim about all versions
or arbitrary hook implementations.

The adapter therefore requires idle state, reads provenance in that same
process, requires a builtin entry with no non-builtin `compact` entry,
dispatches immediately, and rejects another control while the first
is unresolved. A later source change before the boundary makes the result
`failed / command_changed`. It never reloads commands itself. Native source
read and dispatch remain separate messages; the residual idle read/write
window is not atomic and is documented as such.

This is not a repair to ordinary `prompt("/compact")`: replaying the earlier
ordinary command records on main already settled their status correctly.
The special state handling belongs to the new control and its longer wait.

## Input identities

[`claude-merged-identity.ts`](manual-compaction/claude-merged-identity.ts)
and the [native identity regression](../sea-trial/vendor/input-identity.vendor.test.ts)
hold an ordinary reply and submit two native user messages. Both receive
queued receipts before the provider is released. Claude 2.1.316 combines
them into one reply. Its `user_message_uuid` names the latter input and its
`user_message_uuids` lists both in original order. The
[selected evidence](manual-compaction/claude-merged-identity.json) contains
only generated input UUIDs, version and native result fields. The earlier
prompt-plus-steer recording names the original prompt instead; no universal
first/last rule is implied.

OAR now projects these independent native fields as `turn_ended.inputId?`
and `turn_ended.inputIds?`. Missing fields stay missing, including spontaneous
turns without reported input identities. Consumers should mark every entry
in `inputIds` complete when the list is present. OAR does not derive the
plural from the singular or the singular from the plural. The original
native frame is unchanged. This mapping belongs to the shared stream-json
fold, not only Claude. The [result-field probe](manual-compaction/stream-json-result-fields.ts)
on Qwen 0.26.5 and Qoder 1.1.81 observes neither native field; their separate
result `uuid` is not substituted as an input identity. The
[selected fields](manual-compaction/stream-json-result-fields.json) and
three-profile unit regression preserve that boundary.

This differs from OAR's interrupt-merging fallback. That path withdraws
held inputs, then creates one new prompt with its own id. The prompt's
`carries` and the delivery result's `mergedInputIds` retain the original
input identities. Claude normally steers `deliver(interrupt)` and does not
enter that fallback. Existing interrupt regressions cover that separate
host operation.

Eleven existing stream-json projection snapshots change because ordinary
Claude result frames already report these native UUID fields. Their raw
recordings are unchanged. The additions are public projected event fields,
also visible in `Frame.body.events`, not private status metadata. A structural
comparison verifies that each changed snapshot adds only these two fields
with values present in the corresponding raw result.

## Other surveyed entries

| Entry at survey time | Current decision |
|---|---|
| Kimi 2.4.1 | Explicitly unsupported: ACP's text completion is insufficient structural evidence |
| Qwen 0.26.5 | Explicitly unsupported: stream-json omits compression metadata, and a user command can replace `/compress`; [separate evidence PR](https://github.com/botiverse/oar/pull/609) |
| Antigravity 1.4.5 | Explicitly unsupported: no manual compaction entry in the current interface |
| CodeBuddy 2.179.2 | Explicitly unsupported: the dedicated method in published types returned method-not-found in the CLI; slash-command completion/provenance is not established |
| OpenCode v1 1.19.5 | No session control: custom-command precedence and missing verified structural completion; the shared v1/v2 Runtime remains undeclared |
| OpenCode v2 2.2.5, Grok 1.0.70, Qoder 1.1.81, Cursor 1.2.0, Pi Durable 1.4.0 | Undeclared until their own control and correlation regressions; native entry points alone do not prove the OAR contract |

## Reproduce

Point `OAR_CLAUDE_BIN` and `OAR_CODEX_BIN` at the versions above. The Pi
dependency versions are pinned in the workspace.

```sh
OAR_TEST=claude-aimock pnpm vitest run sea-trial/vendor/manual-compaction.vendor.test.ts sea-trial/vendor/input-identity.vendor.test.ts
OAR_TEST=codex-aimock pnpm vitest run sea-trial/vendor/manual-compaction.vendor.test.ts
OAR_TEST=pi-aimock pnpm vitest run sea-trial/vendor/manual-compaction.vendor.test.ts
OAR_TEST=pi-rpc-aimock pnpm vitest run sea-trial/vendor/manual-compaction.vendor.test.ts
pnpm tsx experiments/manual-compaction/claude-command-origin.ts
pnpm tsx experiments/manual-compaction/claude-merged-identity.ts
pnpm tsx experiments/manual-compaction/claude-initialize-effects.ts
# Also set OAR_QWEN_BIN=.../0.26.5/qwen and OAR_QODER_BIN=.../1.1.81/qodercli.
pnpm tsx experiments/manual-compaction/stream-json-result-fields.ts
```

Review regressions also cover native queued-command cancellation without
firing the process-kill fallback, two queued inputs draining one per turn,
provenance timeout and late replies after disposal, conflicting catalog
entries, pre-aborted signals, zero-timeout dispatch, credential redaction in
returned reasons, and disposal/exit without synthetic terminal frames.
An unrelated root goal turn before Codex's `contextCompaction` item cannot
claim its identity; an observed active goal also refuses compact as busy.
`AgentStatus.compaction` contains only `requestId` and `started?`. Native
turn/span correlation stays in serializable fold state, including
`SessionView.statusState`, outside the displayed status; cloned checkpoints
produce the same result as a full replay. Pi returns to idle retaining the
previous ordinary turn outcome.

Unit regressions also retain wrong-root/turn/item negatives, automatic
boundaries, reentrant observers, source changes, old command results,
pending native inputs, incremental status checkpoints, and Pi RPC's native
operation continuing past its usual 30-second request deadline. The full
capability inventory includes Pi Durable and fixes which entries are
supported, unsupported or still undeclared.

## Local validation

The revised implementation passes the full check with 3,043 tests and 18
mock behaviors, all 14 behavior backends, build and clean packed-consumer
validation. Full vendor suites pass for Claude 2.1.316 (80), Codex 0.166.0
(62), Pi SDK 1.4.0 (97) and Pi RPC 1.4.0 (95). The manual compaction file
contributes 33 native controls across the four entries. These runs are Linux
observations; Windows and macOS validation remains pending CI.

After rebasing onto the 0.85.1 release and the DSH/Qwen evidence changes,
the full check still passes with 3,043 tests and 18 mock behaviors. Full
Pi SDK 1.5.0 (97) and Pi RPC 1.5.0 (95) vendor suites pass, including all
16 manual-compaction controls. The capability-inventory fixture now uses
the separate Pi AI 1.4.0 catalog for Durable 1.4.0, matching the released
dependency split; the adapter code is unchanged by this rebase. Build,
clean packed-consumer validation and all three Pi behavior backends also
pass on this baseline.

Two Pi RPC project-package tests previously inherited the managed host's
`PI_PACKAGE_DIR`, pointing at 1.0.56, and hit the existing version guard.
Both now clear that variable in `beforeEach` and restore the host environment
afterward. Their 20 cases also pass with the original host environment
present; the complete suite above uses the intended 1.4.0 package. This is
test isolation, with no change to the product version guard.

The replay comparison covered 11 files and 30 added identity fields, each
matching its own raw result; no other snapshot value changed. Build and
clean packed-consumer validation include the new capability, option and
outcome type exports.

## Release notes draft

- Add optional `Runtime.manualCompaction` and `Session.compact()` with typed
  outcomes on Claude, Codex and Pi SDK/RPC. These implementations require
  idle sessions; unsupported and unverified entries remain distinguishable.
- An already aborted signal returns `rejected / aborted` without sending
  native work; `timeoutMs: 0` still dispatches. After dispatch, a compact wait
  timeout or signal returns `unconfirmed` and does not stop
  native work. The session remains compacting, ordinary prompts are refused,
  and late native outcomes remain observable. Abort uses the native control
  once a target exists. Claude reports mid-compaction cancellation as failure;
  OAR preserves it independently of the ordinary turn's aborted outcome.
  Disposal still works and cannot synthesize a compact result.
- Claude checks same-process built-in command provenance and refuses a user
  override. Codex's evidence covers local compaction; remote ChatGPT-login
  compaction remains untested.
- Add public `turn_ended.inputId?` and ordered `inputIds?`, copied separately
  from reported stream-json result fields. These also appear on ordinary turns.
  Use `inputIds` when present to settle every input covered by a native
  merged turn; OAR's own merged-input provenance remains in `mergedInputIds`
  and `carries`.
