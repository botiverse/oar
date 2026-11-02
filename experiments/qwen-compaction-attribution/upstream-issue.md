# Draft: expose compaction and resolved command identity in stream-json

Status: draft for maintainer review, not submitted upstream.

Qwen Code 0.26.5, Linux x64, persistent `--input-format stream-json
--output-format stream-json --include-partial-messages` session.

## Problem

After a real built-in `/compress`, the compression status is emitted as an
assistant text delta and full assistant message with the current model.
A normal model reply containing the same text has no origin field that a
client could use to distinguish it. Automatic compression produces a real
summary and replaces history, but does not emit a structured compression
frame on this transport.

Classifying by the submitted command is also unsafe. A user can create
`~/.qwen/commands/compress.toml`:

```toml
prompt = "Reply with a short greeting."
```

The same `/compress` input then resolves to the user command, calls the
model, and returns genuine model output without compacting. The command
name advertised at initialization does not identify its source.

## Requested native protocol additions

1. Emit structured stream-json frames for both manual and automatic
   compaction, retaining native phase/outcome and any available trigger,
   counts and operation identity. The ACP compression command already has
   `contextCompression` metadata; expose equivalent observations on the
   stream-json path, including failure/no-op where native data permits.
   Runtime status should be distinguishable from model-authored text.
2. Report the command actually resolved for a submitted turn, including
   whether it is a built-in or a user/extension command. Internal
   `resolvedCommand.name` and `.kind` already carry shadowing-aware identity.
   The client needs this actual result, rather than guessing from the input
   spelling. A dedicated compaction control that bypasses command-name
   resolution would also give hosts an unambiguous trigger, but does not
   replace the need for an observable native outcome.

## Verification

A local mock provider supplies a unique summary only to native summarization
requests. Subsequent main requests contain that summary after manual and
automatic compression. This proves compression occurred independently of
printed status. A second ordinary model reply repeats the exact native
status string. A separate home with the override above makes `/compress`
perform an ordinary model request without any summary request.

The [reproducible probe and selected observations](README.md) retain all four
controls. Relevant 0.26.5 paths: `compressCommand.ts` (ACP metadata versus
headless message), `nonInteractiveCli.ts` (`emitNonInteractiveFinalMessage`),
`BaseJsonOutputAdapter.ts` (`ChatCompressed` is unhandled),
`CommandService.ts` (file commands override built-ins), and
`nonInteractiveCliCommands.ts` (`resolvedCommand`).

Downstream impact: OAR preserves Qwen's raw frames, but cannot safely
normalize compaction events or suppress runtime status from model text.
It will not infer either from text or from a `/compress` input.
