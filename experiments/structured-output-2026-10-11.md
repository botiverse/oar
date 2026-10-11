# Structured output: native channels and boundaries

For [issue #337](https://github.com/botiverse/oar/issues/337), OAR exposes a
session-level `outputSchema` and preserves a native structured result on a
completed `TurnOutcome.structuredOutput`. It does not parse final text or
validate output itself. This makes an application's result available without
losing the runtime's own validation boundary.

## Native observations

Linux x64, October 11, 2026. Claude 2.1.296, Codex 0.162.1 and Grok 1.0.50
ran against local scripted providers in temporary configuration directories.
These probes used no account, login or paid model quota. They test native
agent behavior; they do not establish a real model's schema compliance.

| Runtime | Native input | Successful answer | Negative case |
|---|---|---|---|
| Claude | Process `--json-schema` | `result.structured_output: {answer: 4}` after the native `StructuredOutput` tool succeeds | Repeated `{answer: "wrong"}` fails the integer schema, exhausts five retries, and reports `error_max_structured_output_retries` with `terminal_reason: structured_output_retry_exhausted`. |
| Codex | `turn/start.outputSchema` | `agentMessage.text: "{\"answer\":4}"`; no separate native object | Wrong-typed JSON and `not JSON` both complete if the scripted provider sends them. A provider HTTP 400 schema refusal instead fails the turn. |
| Grok | `session/prompt._meta.outputSchema` | `_meta.structuredOutput: {answer: 4}` with `stopReason: end_turn` | Wrong-typed output or a malformed schema reports `_meta.structuredOutputError`, also with `end_turn`; neither is a successful structured answer. |

Claude's failed validation is currently `failed: unknown`, preserving its
native reason. A malformed schema (`type: "not-a-type"`) made the tested
Claude process exit without a result frame; it is not claimed to fail at
open. Grok's native validation errors are also `failed: unknown`, preserving
the error string. The Codex provider error was `failed: invalid_request`.
No new failure class is introduced here.

Lookout's independent review probes additionally found that Claude can end
successfully without a value even when a schema was supplied. If the model
never calls `StructuredOutput`, or switches to plain text after one invalid
call, Claude reminds it once and then reports `result/success`, `is_error:
false`, without `structured_output`. OAR correctly preserves completed with
no field. Only repeated invalid StructuredOutput calls exercise the retry
exhaustion above. Hosts must check field presence; completed alone does not
establish a schema-conforming result. Lookout also verified that a background
task notification's spontaneous turn can return a native structured value.

The Claude native result fixtures retain the successful result and exhausted
retry result, without the session id or message uuid. Grok's three prompt
reply fixtures retain the successful value, wrong-typed value error and
malformed-schema error. See
[`tests/replay/fixtures/`](../tests/replay/fixtures/), files named
`claude-structured-output-*.raw.jsonl` and
`grok-structured-output-*.raw.jsonl`.

## Scope, continuation and controls

- **Claude:** the flag applies to the process. The same schema remains for
  later prompts, queued input, steering within a turn and native spontaneous
  turns. New and cold-resumed sessions were exercised with the typed option.
- **Codex:** OAR sends the schema on each `turn/start`. A steer stays in that
  existing turn. Neither `thread/queue/add` nor `thread/settings/update` has
  an output-schema setting in the generated 0.162.1 app-server schema, so
  OAR refuses `queue` with `unsupported` for these sessions. A host can send
  a new prompt after completion. An already persisted native queue is not
  retroactively changed by opening OAR with this option.
- **Grok:** OAR sends the extension on every prompt RPC, including a held
  queue drain and a send-now steer, keeping `_meta.sendNow`. The native
  regression exercises all of these and a cold resume. This request-scoped
  option makes no promise about autonomous work without an OAR prompt RPC.
- **Resume:** give the schema again. It is not inferred from old records or
  native configuration. There is no per-turn override in this API.

### Codex native goals

Lookout's independent probe found that a goal continuation starts without
the previous turn's schema. The checked-in
[`codex-goal-continuation.ts`](codex-goal-continuation.ts) adapts that probe
to the shared local provider and reproduces the boundary:

| Observation | Result |
|---|---|
| Client `turn/start` requests | One, with `outputSchema`. |
| Native `turn/started` notifications | Two. The first model response creates an unfinished goal. |
| First turn's provider requests | Two, both with `text.format.type: json_schema`. |
| Continuation requests | Two, both with native goal context and no format. The model completes the goal, ending continuation. |

OAR does not intercept goals or manufacture a schema for their autonomous
turns. Codex users must treat this as a schema for OAR-started turns, not a
guarantee covering every future turn in the thread. Even for an OAR-started
turn, parsing and validating Codex text is the host's responsibility: the
native agent delegates schema enforcement to the provider.

## Other native channels audited

The refusal is about the interface OAR actually uses. It is not a claim that
no other API or a custom extension could implement the feature.

| Runtime | Inspected surface | Decision |
|---|---|---|
| Cursor SDK 1.0.37 | `AgentOptions`, local options and send options in the installed SDK declarations | No final-output setting. MCP tool `outputSchema` describes tool results and is unrelated. Refuse before opening. |
| Pi SDK 1.1.0 | `CreateAgentSessionOptions` and native session prompt options | No final-output setting. Refuse before creating a session. |
| Pi Durable 1.1.0 | Harness conversation and submission types | No final-output setting. Refuse before creating or watching a conversation. |
| Kimi | ACP server/session and launch configuration in source `0999454` | No verified final-output schema channel in the selected interface. Refuse before launch. |
| OpenCode v1/v2 | ACP prompt/configuration paths in source `aec0b9a` / `9b4ec57` | HTTP prompt formatting exists elsewhere but is not forwarded from ACP. No verified launch/configuration equivalent. Refuse both lines. |
| Antigravity ACP 1.3.0 | Selected server's `server.py`, prompt and configuration paths | No final-output schema input; tool parameter schemas do not provide one. Refuse before launch. |

Grok's positive source evidence is in
[`grok-build` `2bdd1d6`](https://github.com/xai-org/grok-build/tree/2bdd1d6):
`xai-grok-pager/src/headless.rs` forwards its CLI JSON schema as the ACP
extension, `xai-grok-shell/src/agent/mvp_agent/acp_agent.rs` accepts it,
`session/acp_session_impl/turn.rs` validates output, and
`agent/mvp_agent/prompt_response_meta_tests.rs` pins the value/error response
fields. The 1.0.50 binary probe confirms that this path is effective today.

## Contract and host impact

`outputSchema` is a JSON Schema object passed unchanged. Unsupported runtimes
declare it in `refusedSessionOptions`; even `{}` is considered present.
Instructions are not rewritten to imitate structured output.

Only a completed outcome can carry `structuredOutput`. Claude and Grok copy
the value they report; missing is distinct from native `null`, and false,
zero and an empty string are retained. Failed or aborted turns carry no
structured value. Raw frames and ordinary text remain available.

The existing `turn_ended` event carries the added optional field, so there is
no new event kind or separate observation state. `promptAndWait`,
`awaitTurnEnd`, `statusOf` and SessionView retain the outcome. JSON-retained
record replay has the same value, with child results excluded from root
completion and no value carried over to a later plain turn.

Hosts opting into Codex schemas must handle its explicit queue refusal and
its text-only result. Existing sessions that omit the option retain their
controls. Hosts can inspect `refusedSessionOptions.outputSchema` before
offering schema configuration.

## Reproduction and validation

Use absolute binary paths with `OAR_CLAUDE_BIN`, `OAR_CODEX_BIN` and
`OAR_GROK_BIN` when the executables are not on PATH.

```sh
pnpm tsx experiments/structured-output-native.ts claude /tmp/oar-schema-claude
pnpm tsx experiments/structured-output-native.ts codex /tmp/oar-schema-codex
pnpm tsx experiments/grok-structured-output-native.ts
pnpm tsx experiments/codex-goal-continuation.ts
OAR_TEST=claude-aimock pnpm vitest run sea-trial/vendor/structured-output.vendor.test.ts
OAR_TEST=codex-aimock pnpm vitest run sea-trial/vendor/structured-output.vendor.test.ts
OAR_TEST=grok-aimock pnpm vitest run sea-trial/vendor/grok-structured-output.vendor.test.ts
```

The focused native tests pass: Claude two cases, Codex four, Grok three.
The complete applicable native suites passed 43 Claude tests and 42 Codex
tests; the five behavior backends each passed 19 applicable scenarios.
The unit/replay tests cover launch forwarding, repeated prompts, cold resume
parameters, queue refusal, schema-bearing steer/queue delivery, native
failure and cancellation, absent/falsey values, child isolation and saved
record replay. The full repository check passed: typecheck, lint, 1,669 unit tests and
the 19 applicable mock behavior scenarios. Package builds passed as well.

Initial test/probe failures were retained separately from passing runs: a
relative Claude executable could not spawn from a temporary cwd; one frame
assertion used `result` instead of the native `result/<subtype>` discriminator;
a queue test inspected before its held input drained; and the adapted goal
probe initially searched JSON-escaped text with an unescaped marker. Fixes
use an absolute executable, inspect the native discriminator, wait for the
queued turn, and read actual content text. None weakened the runtime outcome
checks or converted an invalid value into a successful structured result.
