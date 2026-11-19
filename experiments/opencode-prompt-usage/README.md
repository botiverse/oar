# OpenCode root prompt usage

On Linux x64, OpenCode 2.0.22 and 2.3.2 returned the sum of both model
calls in a root prompt that ran a shell tool. OpenCode 1.19.6 and 2.0.21
returned only the final call. The loopback provider supplied 100 input and
10 output tokens for the shell call, then 200 input and 20 output after
receiving the tool result. It supplied 300 input and 30 output for a
second, single-call turn in the same session.

| Native release | Tool turn: ACP total | Tool turn: final context used | Next turn: ACP total | OAR input / output after both turns |
| --- | ---: | ---: | ---: | --- |
| 1.19.6 | 220 | 200 | 330 | absent |
| 2.0.21 | 220 | 220 | 330 | absent |
| 2.0.22 | 330 | 220 | 330 | 600 / 60 |
| 2.3.2 | 330 | 220 | 330 | 600 / 60 |

[Selected provider counts, ACP readings and OAR totals](observations.json)

## What ACP counts

In 2.0.21 the ACP bridge retrieves the final assistant message by ID and
copies its tokens. In 2.0.22 the bridge began accumulating the root
session's step counters, including a failed step when it carries tokens.
Child steps are excluded. On 2.3.2 the prompt response reads the turn
accumulator and the context update reads the latest step.
[2.0.21 message selection](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/cli/src/acp/event.ts#L394-L402),
[2.0.22 step handling](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/cli/src/acp/translate.ts#L326-L335),
[2.3.2 response](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/cli/src/acp/translate.ts#L167-L183),
[2.3.2 context](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/cli/src/acp/turn.ts#L366-L381).

OpenCode adds five disjoint counters for its total. Its own two-step ACP
test yields 120 input, 15 output, 3 thought, 150 cache read and 50 cache
write. OAR represents the same 338 tokens as 320 input and 18 output.
The cache counts are subsets of input and the 3 reasoning tokens are a
subset of output. The scope is root prompt replies with usage. The native
loopback measurements above exercised input and output. The five-field
mapping is covered by the source control and the OAR regression.
[Native total](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/schema/src/token-usage.ts#L16-L18),
[native accounting tests](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/packages/cli/test/acp/translate.test.ts#L162-L219),
[OAR regression](../../tests/opencode/prompt-usage.test.ts).

## Reproduce

Each run starts a fresh home and a scripted provider. Set
`OAR_OPENCODE_BIN` to the executable for each release and run the
[probe](probe.ts) from the repository root.

```sh
# 1.19.6 and 2.0.21
pnpm exec tsx experiments/opencode-prompt-usage/probe.ts last-step
# 2.0.22 and 2.3.2
pnpm exec tsx experiments/opencode-prompt-usage/probe.ts whole-turn
```
