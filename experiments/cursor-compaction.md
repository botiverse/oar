# Cursor compaction: SDK 1.2.0

Observed on October 28, 2026, on Linux x64 with Node 24.19.0 and an existing
authorized xxwork Cursor login. The selected model was `gpt-5.4-nano`.
Run `pnpm tsx experiments/cursor-compaction.ts <new-output-directory>` to
repeat the native probe. It costs model quota, keeps private JSONL evidence
and bounds the child process to 120 seconds, including native teardown.

## Native observations [env]

One ordinary text-only run consumed `onDelta` and `run.stream()` concurrently.
The concatenated text from each channel was exactly `STORED`; the run finished,
and the iterator closed. Its reported usage was 3,357 input and 23 output
tokens, 3,380 total, with zero cache reads/writes and 14 reasoning tokens
already included in output.

The native `Agent.summarize()` method then triggered a controlled compaction.
The stream reported `summary {status: "running"}` followed by
`summary {status: "completed"}`; `wait()` reported `finished`. A second
summary was cancelled immediately after its `running` message. It reported
the run status `CANCELLED` and `wait()` returned `cancelled`, then the iterator
closed. It did **not** report a terminal summary message. Neither summary
returned usage, so the reported 3,380 tokens do not establish the full cost.

In all three runs, `wait()` returned before the stream iterator ended. A
consumer must drain both before treating the run's observations as complete.
This probe used manual summarization to trigger the native notifications;
it did not fill a context window to observe automatic compaction, and did
not produce a real summary error or fallback.

## Installed bundle evidence [src]

SDK 1.2.0's conversation accumulator filters `summary`, `summary-started` and
`summary-completed` out of `onDelta`. The local run calls that accumulator
first, then maps the same native update into an independent message buffer.
`summary-started` becomes a `running` summary; `summary-completed` becomes
`error` only when `failed` is true, otherwise `completed`. A true `fallback`
flag survives on that message. The summary text itself is not streamed.

The public message type describes both automatic and manual compaction.
Both use the same conversion; there is no native trigger field to distinguish
them. An error leaves the conversation unchanged. Fallback means a trimmed
transcript was saved instead of a model-written summary. Those meanings and
the error/fallback mappings are source/type evidence, not observed provider
outcomes. The live message buffer is capped at 8,192 messages and throws on
overflow; consuming it does not take updates away from `onDelta`.

## OAR mapping

The adapter keeps every `onDelta` frame and every `run.stream()` message.
Stream messages have types `cursor/stream/<native type>` and preserve their
native payload. Only summary messages add projected events: `running` gives
`compaction_started`, `completed` gives `compaction_ended: completed`, and
`error` gives `compaction_ended: failed`. The fallback flag stays native;
trigger and reason remain absent. Other stream messages add no events,
preventing duplicate text, tools and usage. Unknown messages/statuses remain
raw records without an invented interpretation.

Records retain reception order across the two native views. Buffered messages
can arrive after earlier `onDelta` callbacks; OAR does not reconstruct an
unobserved global order. It waits for both the iterator and `run.wait()` before
recording the run result and releasing queued input. Iterator errors become
`cursor/stream_failed` records with no events; they do not replace the run's
own outcome. Cancellation, disposal and failed runs never manufacture a
missing compaction end. A late run returned after disposal is still drained
and cancelled.

Deterministic adapter regressions cover success, failed summaries, fallback,
unknown messages, duplicate suppression, iterator failure, a result preceding
the last summary, cancellation, disposal, failed waits and late runs. The
manual `Agent.summarize()` control remains outside OAR's public API.

This feature requires the exact SDK 1.2.0 peer and matching CLI dependency.
It is separate from the 0.76.0 release, which keeps SDK 1.1.0.

## Validation and retained failure

The reusable native probe passed again without changing its expectations;
the ordinary turn reported another 3,394 tokens and both summaries again
omitted usage. The complete live session battery initially passed 11 cases,
failed `abort`, and skipped `kill-runtime` because Cursor runs in process.
The failed trace requested a 40-second shell loop. The model instead said
sleep-in-shell was disallowed, waited through `AwaitShell`, and finally
executed only `echo NEVER`. That short command was the first observed
`tool-call-started`. The normal two-second test delay outlasted the remaining
run: native `finished` was recorded about 0.6 seconds before the abort
request, which was correctly rejected with `no_active_turn`. The original
failure is retained. An unchanged rerun of only `abort` passed in 13 seconds;
no adapter workaround, assertion or deadline was changed.

The type/lint/unit/mock gate passed: 2,227 unit tests and 19 mock behavior
cases. Build and packed clean installation passed. Across both native probes,
the full live battery and the one abort rerun, 22 run results were retained.
Six omitted usage: four summary runs and two cancelled ordinary runs.
The other 16 reported 252,289 input and 2,473 output tokens, 254,762 total;
176,640 cache-read tokens are already part of input, and 1,477 reasoning
tokens are already part of output. Cache writes were zero. This is reported
usage, not a complete billing total.
