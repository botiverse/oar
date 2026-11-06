# Codex native signals

Checked 2026-11-06 on Linux x64 with Codex 0.163.0 and 0.167.0, a scripted local
provider and no login, to decide whether OAR needed a stderr channel or an OOM
option ([decision](../../docs/design/decisions.md#no-stderr-channel-or-process-priority-option-2026-11-06)).
`OAR_CHILD_STDERR=inherit` captured stderr. Run with
`OAR_CHILD_STDERR=inherit pnpm exec tsx experiments/codex-native-signals/probe.ts <scenario>`;
`OAR_CODEX_BIN` selects the version. The reconnect case is also
[a vendor test](../../sea-trial/vendor/codex-reconnect.vendor.test.ts).

| Scenario | Versions | Stream | stderr | Turn |
|---|---|---|---|---|
| `dropped`: two streams end before `response.completed` | 0.163.0, 0.167.0 | `error` with `willRetry: true` and `Reconnecting... 1/5`, then `2/5` | nothing beyond startup lines | completed |
| `503`: two responses return 503 | 0.167.0 | nothing | nothing beyond startup lines | completed, three requests |
| `badargs`: `exec_command` with arguments that are not JSON | 0.167.0 | no tool item | `failed to parse function arguments` | the model got a second request and the turn completed |
| `badtype`: `exec_command` with `"max_output_tokens":14380.0`, valid JSON of the wrong type | 0.163.0, 0.167.0 | no tool item | `failed to parse function arguments: invalid type: floating point` | the model got a second request and the turn completed |
| `badtype-silent`: the same, and the model's second reply has no text | 0.163.0, 0.167.0 | no tool item, no text | the same line | completed, with no text |
| `wrapper`: `installation.command` is a script running `exec choom -n 500 -- codex "$@"` | 0.167.0 | | | see below |

The `wrapper` case read `/proc/<pid>/oom_score_adj` below the host: the launcher,
the native binary, an MCP server and codex's own `git` helpers all read 500, and
the tool command printed 500 for itself. The form using
`echo 500 > /proc/self/oom_score_adj` was checked in `sh` alone, for the score
surviving `exec` and reaching a child with the pid unchanged, not with Codex.

`badtype` is the shape of the error in Raft's report of a turn going quiet (Codex
0.153.4, a custom OpenAI-compatible provider, `expected i32`). Here the error
reached the model on both versions. In `badtype-silent` the turn ends `completed`
with nothing to show, which is what a host sees if a model answers that way, and
`turn/completed` reports it accurately. That report's original session was not
available, so these runs do not establish what happened in it.

Limits: a scripted provider says what codex does with these inputs, not how often a
real provider causes them or what a real model does next.
