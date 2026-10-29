# Qwen streamed text after thinking, 2026-10-29

Observed on Linux x64 with npm `@qwen-code/qwen-code@0.26.3`, Node 24.19.0,
the native SDK channel and a local scripted OpenAI-compatible provider. No
account, real key or model quota is needed for the reproduction.

## Native evidence and OAR mapping

A plain text response has matching streamed and final message ids and did
not repeat. A response with thinking followed by text emitted this order:

| Native frame | Identity and content |
|---|---|
| `message_start` | id A |
| `content_block_start/delta/stop` | index 0, thinking |
| `assistant` | id A, completed thinking block |
| `content_block_start/delta/stop` | index 0 again, text; no new message start |
| `assistant` | id B, completed text block |
| `message_stop` | end of the stream |

The previous OAR fold counted the text deltas and the final assistant text,
because B differed from A. With the scripted 22-character marker
`OAR_QWEN_TOKEN_PLAN_OK`, `promptAndWait` returned 44 characters before the
fix and 22 after it. Thinking was projected into its own channel throughout.

The Qwen profile now declares that the next single-block assistant is a
snapshot of the stopped block. The fold consumes that structural boundary
once; it does not compare text to establish identity. It still emits a
final block with no preceding text deltas. New block/message boundaries,
the next snapshot and the turn result end eligibility. Different agent
lanes cannot consume each other's boundaries. The raw frames retain their
original ids and content.

Pure regressions include repeated paragraphs within one answer, identical
answers across two turns, final-only content, another agent, boundary
invalidation and an unchanged default for other stream-json dialects.
Native vendor tests use both plain text and thinking plus text, with the
same repeated paragraphs in two consecutive turns. They assert the public
reply and reasoning channels, rather than relying on the buggy id shape
remaining in future Qwen versions.

Reproduce the native frames without OAR's session/projection code:

```sh
pnpm tsx experiments/qwen-native/probe.ts /absolute/path/to/qwen oar-trial-run/qwen-reply-blocks reply-blocks
```

Inspect the `stream_event` and `assistant` frames in `fresh.wire.jsonl`.
The provider responses and both native sessions are synthetic and isolated.
Run the public behavior regression with:

```sh
OAR_TEST=qwen-aimock OAR_QWEN_BIN=/absolute/path/to/qwen pnpm vitest run sea-trial/vendor/qwen.vendor.test.ts
```

## Real Token Plan observations

Two consented runs used Qwen 0.26.3, Linux x64, Node 24.22.1 and Model
Studio's Singapore Token Plan endpoint with model `qwen3.7-plus`. Provider
discovery, native connect, persisted address readback, local credential
presence, model listing and completed turn all passed. Configuration
success alone was not treated as remote authentication evidence.

The first run used 21,957 input and 319 output tokens and failed exact
reply validation. The second used 21,985 input and 213 output tokens,
including 5,380 cache-read tokens in input. Its content-free report showed
44 reply characters, the 22-character marker present, three text events
and seven reasoning events totaling 76 characters. Neither trimming nor
removing a final period matched the marker. This motivated the isolated
reproduction above; the real report alone did not prove the native cause.
No real response content, key or account identifier was collected.

`token-plan-real.ts` revision 3 adds `equalsMarkerTwice`. It uses a private
temporary HOME, accepts a key only through `OAR_QWEN_TOKEN_PLAN_KEY`, writes
a mode-0600 report, then disposes processes and removes the private HOME.
The key reaches native provider configuration on stdin, not argv. The
report excludes raw frames, native errors and model text. The third consented real run passed: exactly 22 reply characters,
`equalsAfterTrim: true`, `equalsMarkerTwice: false`, seven reasoning events
and 91 reasoning characters. The turn completed with 21,971 input and 230
output tokens. Process cleanup and removal of the private HOME both passed.
The repair package used base `2287205` plus the source changes committed as
`b28339d`; only the evidence documentation changed afterward.

The original content-free reports are retained as
[before v1](token-plan-2026-10-29/before-v1.json),
[before v2](token-plan-2026-10-29/before-v2.json) and
[after v3](token-plan-2026-10-29/after-v3.json).
The first report establishes a failed exact-text check; the second adds
length and channel diagnostics. Only the isolated native probe proves the
id mismatch. The repaired real run establishes success for this provider,
model, version and machine, not every account, model or platform.

## Upstream issue draft

Title: SDK stream-json text snapshot changes message id after thinking without a new message_start

This report was investigated and drafted with AI assistance. Publication
and final wording require maintainer review; it has not been submitted.

Version: `@qwen-code/qwen-code@0.26.3`, Linux x64, Node 24.19.0.

Reproduction:

1. Configure an OpenAI-compatible local provider that streams
   `reasoning_content`, then `content` in the same completion. Synthetic
   strings are sufficient; a plain-text-only response is the control.
2. Start `qwen --input-format stream-json --output-format stream-json
   --channel=SDK --include-partial-messages --approval-mode yolo --model
   gpt-5.1` with an isolated HOME and that provider's synthetic key.
3. Send a control `initialize` request first, wait for its reply, then
   send a user message. The repository probe above automates these steps
   directly against the CLI, without OAR's adapter.
4. Compare the `message_start.message.id` with both final
   `assistant.message.id` values using the sequence in the table above.

Expected: a final assistant snapshot has the same message id as the
streamed blocks it completes, or a new `message_start` identifies a new
message before its deltas.

Actual: the thinking snapshot uses A, but the text snapshot uses B without
an intervening `message_start`; block index 0 is reused. Consumers matching
snapshots by message id can present the text twice. The provider only sent
one text answer. Plain text without thinking retains a matching id.

OAR currently handles the observed native block sequence explicitly. A
stable, documented identity relationship would let SDK consumers match
partial messages and snapshots without this dialect-specific rule.
