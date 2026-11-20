# What happens to the next prompt after compaction fails?

Linux observations with real runtimes and a loopback model provider. Two seed
turns established history. During a third prompt the provider returned a
context-length error, then rejected subsequent requests. After the turn ended
the provider resumed serving the same session. No manual compact request,
resume or process restart was involved.

| Runtime | Automatic compaction evidence | Active turn | Following prompt |
| --- | --- | --- | --- |
| Claude Code 2.1.326 | `system/status` started and ended failed with the summary provider's error | `failed/input_too_large` | Completed |
| Pi 1.5.2, in-process and RPC | `compaction_started` and failed `compaction_ended`, both with `trigger: "overflow"`; separate summarizer request rejected | `failed/input_too_large` | Completed |
| DSH 0.2.2-rc.5 | Matching native compaction start/end, with the second provider error in the failed end | `failed/input_too_large` | Completed |
| OpenCode 2.2.7 and 2.3.2 | ACP reported matching automatic start and failed end. Only the original failing model request reached the fixture. | `failed/input_too_large` | Completed |
| Codex 0.169.0, native usage threshold | Setting `model_auto_compact_token_limit` and raising reported usage triggered `contextCompaction`. Its model request failed. The recording contained a start and a failed turn end. | `failed/invalid_request` | Retried compaction and completed |

On both tested OpenCode v2 versions the native error was JSON-RPC `-32603`
with `data: { service: "session", errorName: "provider.invalid-request" }`.
Its message was:

> Internal error: This model's maximum context length is 10000 tokens. However, your messages resulted in 18000 tokens. Please reduce the length of the messages.

An ordinary rejected request had the same error name. A separate usage-threshold
control on 2.3.2 reached the summary provider; its rejection came back as
`Internal error: Controlled summary failure` with the same error name.
When the summary provider returned the required template on the following
prompt, that same session completed it. The shared failure reader distinguishes
explicit overflow from the separate provider failure and preserves the native
message as `reason`.

All five returned to typed `idle`. The failed turn remains available in
`status().value.lastTurnOutcome` until another turn changes it. In these
runs the session remained usable. A compaction failure alone provides no
evidence for a permanent unusable state.

The same injected overflow gave these additional observations. A retry or
a provider rejection, on its own, cannot establish a failed compaction.

| Runtime | What the host could establish |
| --- | --- |
| Codex 0.169.0, reactive overflow | The original turn failed with `input_too_large`. It had no compaction start. On the next prompt the summary request succeeded and the turn completed. |
| Grok 1.0.70, Qwen 0.27.4, Factory 1.12.1 | The turn failed (`invalid_request`, `unknown`, `invalid_request` respectively) and the following prompt completed. No typed compaction boundary identified a failed automatic summary. |
| OpenCode 1.19.5 | ACP reported `failed/provider` and the next prompt completed. Version 1 provides no verified automatic compaction boundary. |
| Kimi 2.6.3 ACP | ACP answered with a completed turn and the following prompt completed. No failed automatic compaction was identifiable. |
| Qoder, Cursor | Unknown. The available notification recordings and SDK fixtures did not exercise a failed automatic summary against a controlled provider. |
| Pi Durable | Unknown. Its host-created harness has a separate lifecycle from the bundled Pi SDK/RPC tested here. |
| Antigravity, CodeBuddy, Devin | Unknown. No native automatic failure boundary has been verified with a controlled next prompt on these interfaces. |
| Community Cybion and Morph | Unknown. No native failed-summary fixture was available for either adapter. |

**Manual compaction.** A separate provider-failure control returned
`failed/native_failed` from `compact()`, returned the session to idle and
completed the next prompt on Claude 2.1.326, Codex 0.169.0, Pi 1.5.2 in both
execution modes, Grok 1.0.70, OpenCode 2.2.7 and DSH 0.2.2-rc.5.

The [overflow regression](../../sea-trial/vendor/automatic-compaction-failure.vendor.test.ts)
checks the typed turn and recovery on Claude, Pi and OpenCode v2. The
[DSH suite](../../sea-trial/vendor/dsh-compaction-images.vendor.test.ts)
checks both triggers and the
[Codex suite](../../sea-trial/vendor/resume-system-prompt.vendor.test.ts)
drives its threshold through native usage. Run the relevant file with
`OAR_TEST` set to the vendor backend and its runtime binary selected.
