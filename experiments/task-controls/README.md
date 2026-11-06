# Native task lifecycle and single-task stop

Linux observations on 2026-11-06. These probes establish native controls and
wire facts; task completion is never inferred from accepting a stop request.

| Runtime | Observed control | Outcome and OAR mapping |
| --- | --- | --- |
| Claude 2.1.318 | Native `stop_task` on one background Bash task; public OAR control on Bash and foreground Agent tasks | Target reported stopped, sibling completed, later parent prompt completed. Unknown ID also returned success. OAR exposes `stopTask`; acknowledgement is not completion. |
| Codex 0.167.0 | `turn/interrupt` on one active child thread, then parent `followup_task` to the same child | Child turn interrupted, peer and parent continued; same child ran a new turn successfully. OAR exposes `stopTask` for observed descendants, but does not turn a child's turn completion into a task ending. |
| Grok 1.0.77 | `session/cancel` naming one child after both child model calls began | Both children completed normally. OAR projects native spawned/finished updates but has no `stopTask`. |
| Qoder 1.1.83 | Native `stop_task` on foreground and background agents | Both target tasks reported stopped; background peer completed. OAR exposes the native control and projects task frames. Later parent-prompt result is unconfirmed; see below. |
| Qwen 0.26.8 | Background `agent` tool with local provider | Structured task start and completion arrived under `data`. OAR projects these; no verified host single-task stop. |

Claude, Codex, Grok and Qwen use local scripted providers. Qoder's replay is
unavailable on 1.1.83, so Bugen ran a bounded real probe: three submitted root
prompts with a DeepSeek pay-as-you-go `deepseek-flash-pg` configuration and a
Free login. No plan was purchased. This does not validate a first-party plan.
The three nonzero native results reported 108,567 input tokens, 90,368 cache-read
tokens and 755 output tokens. Their native `costUSD: 0` is not a billing claim.
Configuration removal and daemon exit were reported by the probe.

## Selected evidence

- [Claude](evidence/claude-2.1.318.json): target and sibling endings, success for an unknown ID.
- [Codex](evidence/codex-0.167.0.json): interrupted turn, continued child and native parent task facts.
- [Grok](evidence/grok-1.0.77.json): both child endings after targeted cancellation.
- [Qoder](evidence/qoder-1.1.83.json): public sanitized output supplied by Bugen, retained unchanged.
- [Qwen](evidence/qwen-0.26.8.json): nested native task payloads.

The CI-pinned Qoder 1.1.81 also acknowledges an unknown task ID without
emitting a task event, verified through OAR with an isolated native process
and no inference. This is only an acknowledgement check; live task stops
were established on 1.1.83.

Qoder emitted two distinct stopped notifications for its foreground target,
then acknowledged stop and reported a killed patch. All remain distinct facts.
The background start frames do not say `is_backgrounded`, so the projection
leaves `background` absent. The probe labeled the next root success as a
parent follow-up, but did not retain sufficient command correlation. A later
`error_during_execution` result was also saved, without error details or
command-lifecycle fields. We therefore do not claim that the follow-up
succeeded or explain the error. No retry or additional inference was run.

Qwen upstream at `6fb741642f124cebeb50b9e1d593722ec4b48fa9` wires background
registry starts and notifications in
[`nonInteractiveCli.ts`](https://github.com/QwenLM/qwen-code/blob/6fb741642f124cebeb50b9e1d593722ec4b48fa9/packages/cli/src/nonInteractiveCli.ts)
and persistent
[`nonInteractive/session.ts`](https://github.com/QwenLM/qwen-code/blob/6fb741642f124cebeb50b9e1d593722ec4b48fa9/packages/cli/src/nonInteractive/session.ts).
The local 0.26.8 run confirms the wire shape. Source-only model tool
`task_stop` does not establish a host control. Some monitor task frames share
the channel but lack a subagent type; OAR does not call them agents.

## Reproduce

After `pnpm install`, select each installed binary with its usual `OAR_*_BIN`
variable and run `pnpm tsx experiments/task-controls/claude-native.ts`,
`codex-native.ts`, `grok-native.ts` or `qwen-native.ts`. An optional first
argument changes the local output directory. Raw local output can include
machine paths and must be reviewed before publishing.

`qoder-native.ts` is separate and manual: set `QODER_PROBE_COMMAND` privately.
Without `--run` it checks native BYOK access without inference. `--run` needs
an explicitly authorized real account, privately injected `DEEPSEEK_API_KEY`,
and the documented three-prompt budget. It creates a unique custom-model
configuration and removes it afterwards. Never put this probe in CI.

The native vendor regressions are `task-stop.vendor.test.ts` for Claude and
Codex and `qwen.vendor.test.ts` for Qwen. Qoder's captured frames and the
shared native-control transport have unit/replay regressions. Grok wire tests
retain parent/child attribution. Other tests cover concurrent acknowledgements,
refusals, timeout, exit, disposal, late replies, descendant ownership and reuse
of a Codex child after interruption. Platform results beyond Linux belong to
the PR CI, not this evidence table.

## Validation

The final Linux check passed typechecking, lint, 3,602 unit tests and 18 mock
behaviors. Validation also passed all 16 behavior backends, package builds and
a clean installation of the packed packages. The complete native vendor suites passed:
Claude 2.1.318 (82 tests), Codex 0.167.0 (76), Grok 1.0.70 (21),
Qoder 1.1.81 (14), and Qwen 0.26.8 (19). The Grok and Qoder CI versions
differ from the newer versions in the native observation table above.

Seven focused mutations were caught: allowing an unrelated Codex child,
clearing a newer child turn on an old ending, releasing the root when stopping
a task, reading Qwen task fields at the wrong level, removing the Grok
projection hook, removing credential redaction, and dropping Qoder's killed
status mapping. The root-release mutation initially survived because the
held queue also kept the session busy; the regression now checks the active
root before adding that queue, and catches the mutation. Existing replay
snapshots remain unchanged; the Qoder task fixture adds a new snapshot.

### Concurrent provider routing correction

The 0.91.0 release PR's Ubuntu Codex job
([run 42188288052](https://github.com/botiverse/oar/actions/runs/42188288052/job/127793773215))
observed three target-provider calls where the test requires two. That run did
not retain this case's provider bodies, so its exact cause remains unconfirmed.

The old fixture read the last global raw request when aimock invoked a callback.
A local three-request control reproduced the race without Codex: concurrent
parent, child A and child B requests all received child B's reply. Aimock drops
native `agent_message` items during normalization, so the fixture now forwards
each request's own recipient in a fixture-only message. Original captured
requests remain unchanged. The native probe uses the same correction.

The HTTP regression holds all three callbacks until they have arrived, then
checks each response against its own recipient and verifies raw preservation.
The native case keeps the exact two-call, interruption, peer, parent and child
reuse assertions. It now saves provider bodies and session records even on
assertion failure, so another failure can distinguish routing from a native
extra request. No OAR product behavior or test deadline changes.

The next Windows run
([run 42191203262](https://github.com/botiverse/oar/actions/runs/42191203262/job/127803374639))
retained the new diagnostics and exposed a separate ordering assumption:
`turn/started` arrived before the target's first model request. The test
interrupted that turn before it reached the provider, then the resumed turn
completed with one target request in total. Both native turn outcomes were
correct, but the fixture expected two provider calls. The test and native
probe now require the first target request to reach the provider before
interrupting. The final two-call, different-turn, peer and parent assertions
remain unchanged. This does not explain the earlier Ubuntu three-call failure.

### Replies interrupted by native task messages

PR #664's macOS Codex job
([run 42205301180](https://github.com/botiverse/oar/actions/runs/42205301180/job/127850305048))
retained five parent requests, one target request and no resumed target turn.
The fourth parent request contained `PARENT_FOLLOWUP`; the fifth also contained
the sibling's native final message, but no executed `followup_task` result.
The fixture offered recovery only on request four, then switched to an ordinary
reply. The parent completed without actually resuming its child. This case does
not call `observeStalls`, the observer changed by that PR.

A Linux Codex 0.166.0 control reproduces this sequence: keep the sibling running
until the follow-up model request arrives, then hold that reply until the
sibling's native completion is observed. The old script fails the same resumed
child completion assertion, with five parent requests and one target request.
The corrected script chooses all parent actions from user input and tool results,
and chooses the child response delay from its task payload. Request counters
are diagnostics only. A discarded proposal remains available on the next request;
an executed tool result prevents another execution.

HTTP regressions cover both spawn steps and follow-up before and after their
results, including intervening peer messages. The native case runs both sibling
completion orders and retains the exact two target requests, interrupted first
turn, completed second turn, distinct turn IDs and usable parent and peer. It
also requires exactly one native follow-up activity. The interrupted-proposal
case requires at least two provider proposals but only that one execution.
Both orders retain provider bodies and records on failure. No product behavior,
assertion deadline or existing lifecycle assertion is relaxed.

Run the provider-only regressions with
`pnpm vitest run tests/codex-task-script.test.ts`, and both native orders with
`OAR_TEST=codex-aimock pnpm vitest run sea-trial/vendor/task-stop.vendor.test.ts`.
The native artifacts are `codex-task-stop-before.json` and
`codex-task-stop-during.json` in the trial run directory.
On Linux, the corrected cases, direct native probe and all 77 Codex vendor
checks pass with Codex 0.167.0. macOS and Windows results belong to the new CI
run, not this local validation.

## Release-note draft

- Add optional `Session.stopTask(taskId)` for Claude, Codex and Qoder. The
  returned `ControlOutcome` confirms the native request only. It neither
  ends the root turn nor synthesizes task completion. Other sessions lack
  the member.
- Add Grok, Qoder and Qwen native task projections using the existing three
  task event types. Native fields and missing identity remain truthful;
  task usage does not become inferred spend.
- Codex stops only the observed active child turn. The same child can
  receive later work, and only native parent task activity changes its task
  lifecycle. Missing active turns and unrelated IDs are explicitly refused.
