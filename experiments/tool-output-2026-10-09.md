# Tool output and native activity: 2026-10-09

Issue [#261](https://github.com/botiverse/oar/issues/261) exposed two distinct
native output shapes. Codex sends chunks; Pi and ACP send a current preview.
A SessionView that replaced its output on every Codex chunk retained only
the last one.

## Contract and host impact

`tool_call_progress.output` means replace the current preview;
`outputDelta` means append a chunk. When both occur, replace first and then
append. Codex now uses `outputDelta`. Pi, ACP and Pi Durable keep `output`;
Durable still reconstructs its bounded trim/append/set window. Native frames
remain unchanged. SessionView accumulates deltas per call and lane, replaces
snapshots, and clears the preview on a native tool result. Late output does
not reopen an ended tool.

Hosts folding events themselves must read Codex chunks from `outputDelta`
and append them. Existing records are not rewritten: an older Codex record
still has its chunk in `output`, under the earlier ambiguous contract.
Consumers of SessionView get the corrected preview automatically.

Codex `turn/started` and Pi `agent_start` now report `turn_active`. They can
adopt a queued or SDK-started run without inventing an OAR prompt request.
A prompt request and its native start still produce one visible turn. An
already running phase is retained, and child activity cannot start the root.

## Cursor SDK 1.0.37 boundary

The installed SDK's
`dist/cjs/vendor/cursor-sdk-shared/delta-types.d.ts` declares
`ShellOutputDeltaUpdateSchema` as `type: "shell-output-delta"` plus an
`event` object. The corresponding native schema in `dist/bundled/index.js`
has a oneof of `stdout`, `stderr`, `exit` and `start`, with no call id.
The stdout/stderr payload is `{data: string}`.

Following the producer in that bundle shows the stream originates in
`shellCommandAction`, which executes a standalone shell command using its
`execId`; the public delta does not expose that id. It is distinct from the
model's shell tool, whose start and completion carry `callId`. OAR therefore
keeps `shell-output-delta` verbatim with no projected tool event. Inferring a
call id from whichever tool happens to be running would misattribute it.
`tests/cursor/cursor-projection.test.ts` pins this boundary even with one
active shell tool. Recheck the schema and producer when upgrading the SDK.

A real account probe on xxwork, using the existing authorized login and
`gpt-5.4-nano`, ran:

```sh
pnpm tsx experiments/live-contract.ts cursor --only tool-detail \
  --model gpt-5.4-nano --out oar-trial-run/cursor-tool-output
```

It completed a shell call `echo TOOL-MARK-4412`. The 48 native/open/result
frames included one `tool-call-started`, one `tool-call-completed` with the
same call id and the marker in stdout, and no `shell-output-delta`. This
single run corroborates the source distinction; it does not establish that
every possible Cursor tool run has the same event sequence. The SDK reported
24,491 input tokens (including 7,680 cache reads) and 104 output tokens.

## Repeatable regression coverage

- `tests/tool-output-delta.test.ts`: actual Codex projection loses the first
  of two chunks before the fix; live and replay views agree afterward. Pi's
  partial-result snapshot replaces accumulated chunks. Empty snapshots,
  absent fields, partial histories, child isolation and late output are pinned.
- `tests/native-turn-active.test.ts` and the Codex/Pi session adapter tests:
  native starts without an OAR prompt, existing phase retention, one visible
  turn and child attribution.
- Codex and Pi recorded-frame fixtures: native start frames now carry
  `turn_active`; the original native payloads remain unchanged.
- Codex/Pi vendor tests check that real binaries/SDK events carry this
  projection, using local scripted providers rather than account quota.
