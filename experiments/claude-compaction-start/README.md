# Claude Code compaction start on 2.1.326

On Linux x64, Claude Code 2.1.326 emitted `system/status` with
`status: "compacting"` before both a manual compaction and an automatic
recovery from an oversized prompt. A host can act on that frame. The
`compact_boundary` later identifies which kind of compaction completed.

| Scripted case | Native frames in order |
| --- | --- |
| Call `session.compact()` after a completed turn | `status: "compacting"`, `status: null`, `compact_boundary` with `trigger: "manual"` |
| Answer a local file-read tool result once with HTTP 400 `prompt is too long: 250000 tokens > 200000 maximum`, then allow recovery | `status: "compacting"`, `status: null`, `compact_boundary` with `trigger: "auto"`, then the turn completes |
| Hold the automatic summary provider reply for 34 seconds | Two `status: "compacting"` notices, both with `compact_output_chars: 0`, then a clear and an auto boundary |
| Reject the manual summary requests with HTTP 400 | `status: "compacting"`, then `status: null` with `compact_result: "failed"` and native `compact_error`. No boundary. |
| Report 195,000 input tokens on the tool call and accept its result | Ordinary `requesting` statuses. No compaction frame in this turn. |

The [selected frames](observations.json) show one `compaction_started` when each agent
first enters compaction, including the delayed summary. The start frame carries neither a trigger nor a
compaction id. A plain status clear emits no end. The boundary yields one
`compaction_ended` with the native trigger, and the explicit failed status
reports the failure with its native reason. On a clear, result or exit
without a native terminal, a host can see a start alone. The high-usage control does
not establish a threshold. Idle or background compaction was outside
these controls.

Run the [probe](probe.ts) with the pinned executable. Each case opens a fresh
home and project against a loopback Anthropic provider.

```sh
for mode in manual overflow slow-overflow manual-failure high-usage; do
  pnpm exec tsx experiments/claude-compaction-start/probe.ts "$OAR_CLAUDE_BIN" "$mode"
done
```
