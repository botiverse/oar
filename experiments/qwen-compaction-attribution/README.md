# Qwen compaction attribution

Runtime version check: 2026-11-02

Qwen 0.26.5 on Linux x64, synthetic provider, isolated home and project.
OAR preserves the native frames and makes no additional compaction inference.
The stream-json transport supplies neither a reliable origin discriminator
for manual compression status nor a structured automatic-compression event.

## Native controls

| Control | Native compaction | Observable stream-json result |
| --- | --- | --- |
| Built-in `/compress` | One summary request; later model request contains its unique summary | Compression status is an assistant text delta and full assistant message; no compaction frame |
| Ordinary model reply containing that exact status | No additional compaction | The same text is legitimate assistant output |
| Automatic compaction | One summary request before the next main request, which uses its summary | Normal assistant output; no compaction frame or OAR compaction event |
| User `compress.toml` overrides `/compress` | No compaction or summary request | User command prompt reaches the model and its real reply becomes assistant output |

The built-in manual command produced only its status in the observed turn.
That does **not** make the input token `/compress` an attribution boundary:
the native command resolver allows a user command with that name to replace
the built-in. OAR cannot tell which command ran from that input or from the
advertised command name alone. A future OAR control must not classify the
whole turn as compression merely because it sent `/compress`.

The manual status and the deliberately identical model response both use
`message_start`, text `content_block_*`, `assistant`, `message_stop`, and
`result` frames. Random message IDs and the current model are populated in
both. The result differs in turn/usage counters, but those describe execution
accounting, not command identity; other local commands use the same output
path. They also arrive after streamed text. No counter or text heuristic is
used to classify these records.

For automatic compaction the mock provider declares a 100,000-token context
window in its model-provider entry. One normal reply reports 90,000 input
tokens. Only the native summarization request receives
`OAR_NATIVE_SUMMARY_1`; the following main request must contain it. The
manual control uses the same summary and history assertions. This separates
actual history replacement from command acceptance and from printed status.
Auxiliary memory requests remain counted separately in the selected evidence.

## Source of the lost attribution

The published npm version points to
[`db0e4e24`](https://github.com/QwenLM/qwen-code/tree/db0e4e24a0d89b211b2a15f4af2be22adac71dfc).
Its
[`compressCommand.ts`](https://github.com/QwenLM/qwen-code/blob/db0e4e24a0d89b211b2a15f4af2be22adac71dfc/packages/cli/src/ui/commands/compressCommand.ts)
has structured `contextCompression` metadata in the ACP branch, while the
headless branch returns an ordinary message.
[`emitNonInteractiveFinalMessage`](https://github.com/QwenLM/qwen-code/blob/db0e4e24a0d89b211b2a15f4af2be22adac71dfc/packages/cli/src/nonInteractiveCli.ts)
sends that message through the same content event/output adapter as model
text. The
[`BaseJsonOutputAdapter`](https://github.com/QwenLM/qwen-code/blob/db0e4e24a0d89b211b2a15f4af2be22adac71dfc/packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.ts)
does not handle the core `ChatCompressed` event, so automatic compression
also loses its structured observation on this transport.

[`CommandService`](https://github.com/QwenLM/qwen-code/blob/db0e4e24a0d89b211b2a15f4af2be22adac71dfc/packages/cli/src/services/CommandService.ts)
loads built-ins before file commands and lets a non-extension file command
override a built-in. The internal
[`resolvedCommand`](https://github.com/QwenLM/qwen-code/blob/db0e4e24a0d89b211b2a15f4af2be22adac71dfc/packages/cli/src/nonInteractiveCliCommands.ts)
already distinguishes command name and kind, but this information is not
included in these stream-json output frames.

## Reproduce and inspect

```sh
OAR_QWEN_BIN=/absolute/path/to/qwen pnpm tsx experiments/qwen-compaction-attribution/probe.ts /tmp/qwen-compaction-evidence
python3 experiments/qwen-compaction-attribution/select.py /tmp/qwen-compaction-evidence > /tmp/qwen-compaction-selected.json
```

The [probe](probe.ts) uses the real runtime through OAR. It asserts successful
native turns, actual summary use, identical model/status text, the shadowed
command's model request, and the absence of normalized compaction events.
It writes complete local records and provider requests, which may contain
temporary paths. The [selector](select.py) retains only portable observations:
[selected evidence](selected.json). Counts include auxiliary requests, whose
last user input lacks the probe's main-request marker. No raw home, endpoint,
credential or random session identifier is committed.

These controls do not establish behavior on other platforms or future Qwen
versions. No product code changes. Qwen's proposed typed compaction control
remains unsupported until the native transport reports whether compaction
actually ran and can distinguish overridden commands. The
[upstream issue draft](upstream-issue.md) is for maintainer review and has
not been submitted.
