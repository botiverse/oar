# OpenCode v1 automatic compaction over ACP

OpenCode 1.19.6 completed an automatic compaction within an ordinary
`session/prompt` on Linux x64. Its database recorded a part with
`type: "compaction"`, `auto: true` and `overflow: false`, plus a finished
summary message. The local provider received the summary in the next
assistant request during the same prompt and again on the next turn.
The ACP client received no identifiable start or end.

Two fresh sessions used the same four prompts and the same scripted
provider. The provider reported 195,000 input tokens for the first
assistant response to the pressure prompt against a 200,000-token model
context, and 1,000 for each other response. No prompt requested compaction.

| Observation | Automatic compaction enabled | Automatic compaction disabled |
| --- | --- | --- |
| SQLite compaction parts / finished summaries | 1 / 1 | 0 / 0 |
| Provider requests during the pressure prompt | Assistant, summary, assistant with summary | Assistant |
| All incoming ACP messages during the pressure prompt | 7 assistant text chunks, 1 usage update, 1 prompt result | 1 assistant text chunk, 1 usage update, 1 prompt result |
| Context usage after seed, pressure, follow-up | 1,000 / 1,000 / 1,000 | 1,000 / 195,000 / 1,000 |

The enabled session streamed an acknowledgement, the summary, and another
acknowledgement under three assistant message IDs. The five summary
chunks carried only `sessionUpdate`, `messageId` and `content`. In the
disabled session, an ordinary answer to the fourth prompt emitted the
same five chunks with identical text and field shapes. Both pressure
prompts returned `end_turn` with empty `_meta`. Neither summary text nor a
usage drop identifies compaction. The selected file includes the first
matching chunk from each session with local message ID aliases.
[Selected observations](selected.json).

In the tagged source, the ACP event handler records part metadata
internally, emits tool updates for tool parts and forwards assistant
text deltas as ordinary chunks. The usage update reads the last
assistant message's context tokens when the prompt settles.
[Event handler](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/acp/event.ts#L191-L245),
[prompt settlement](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/acp/service.ts#L521-L544),
[usage calculation](https://github.com/anomalyco/opencode/blob/f4e363c8295fa90a03dddc451882fffe8fbce357/packages/opencode/src/acp/usage.ts#L197-L218).

## Reproduce

Run from the repository root with dependencies installed, Node.js 24+,
and the 1.19.6 executable. Give each run a new output directory. The
probe opens its isolated SQLite database read-only and saves the
selected database rows, full JSON-RPC traffic and scripted provider
requests. Only the loopback provider supplies model responses.

```sh
bin=/absolute/path/to/opencode
pnpm exec tsx experiments/opencode-auto-compaction/probe.ts "$bin" /tmp/oc1-auto auto
pnpm exec tsx experiments/opencode-auto-compaction/probe.ts "$bin" /tmp/oc1-control control
```
