# OpenCode retries and cancellation over ACP

Linux, November 19, 2026. We used the installed `opencode-ai` 1.19.6 and
`@opencode/cli` 2.3.2 executables with fresh homes, isolated sessions and a
local Anthropic-compatible provider. The provider returned one transient
overload, then answered normally. We recorded each provider attempt and the
original prompt's ACP response. The [selected frames and timings](controls.json)
contain no prompts, tool contents or account data.

| Control | 1.19.6 | 2.3.2 |
| --- | --- | --- |
| Let the retry run | Second attempt after 2.19 s, then `end_turn` | Second attempt after 2.21 s, then `end_turn` |
| Cancel during backoff, before the second attempt | `end_turn`, recorded as `completed` | `cancelled`, recorded as `aborted` |
| Cancel during an ordinary slow reply (no retry) | `cancelled` | `cancelled` |
| Send another prompt after cancellation | Completed | Completed |

The 1.19.6 session processor sets an internal retry status. Its ACP handler
only consumes the idle status and emits no retry update. A host can observe
silence, but cannot recover a retry count or next attempt time from that
silence. The 1.19.6 prompt response maps `MessageAbortedError` to `cancelled`
and an assistant message without an error to `end_turn`. An accepted host
cancellation can race normal completion. The adapter preserves the response
the runtime supplied.
[Retry policy](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/session/retry.ts),
[ACP event handling](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/acp/event.ts),
[ACP prompt outcome](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/acp/service.ts).
