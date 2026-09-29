# Codex 0.159.0: instant interrupt

Observed on 2026-09-29, Linux x64 / Node 24.19.0, using the unmodified OAR
adapter at `f1b0b3b` and the real Codex 0.159.0 app-server. The model provider
was a local scripted Responses server: no login, API spend or model behavior
is involved. This checks delivery and stream handling, not model compliance.

## Decision for OAR

Keep the existing `steer()`, `queue()` and `abort()` mappings. No new RPC or
portable Session option is required. Codex's native
`features.instant_interrupt` configuration already reaches sessions opened
through OAR. Preserve its default-off setting: Codex labels the feature
`under development`, and client-side handling of interrupted assistant items
is incomplete upstream.

The feature changes when an accepted steer reaches the next model request.
It does not turn a steer into a session abort, guarantee that arbitrary tools
stop, or strengthen `accepted` into proof of model attention. OAR should keep
recording native events faithfully rather than inventing an item cancellation
or deleting text deltas the runtime already emitted.

## Seven controlled cases

The stream cases hold an unfinished response open until after a 500 ms
observation window (or until a replacement arrives). The tool cases run a
three-second sleep and print a marker. Timings below are one observation,
measured from issuing the control, not latency guarantees.

| Case | Observation |
| --- | --- |
| Flag off, steer during response | No replacement while the response was held; after release, the new input and completed old text reached the next request in the same turn. |
| Flag on, steer during response | Replacement arrived in 41 ms while the first response was still held. It included the new input and completed commentary, excluded unfinished assistant text, and ended the same turn normally. |
| Flag on, queue during response | No preemption. The old turn completed; queued input started a second native turn. |
| Flag on, abort during response | One native `interrupted` turn end; no replacement model request. |
| Flag off, steer during code-mode exec | Next request waited for the underlying command, about 2.9 s after steering; its result survived. |
| Flag on, steer during code-mode exec | Next request arrived in 38 ms with a running cell ID. A subsequent native `wait` collected the eventual command result; the cell kept running and the turn completed once. |
| Flag on, steer during a direct tool call | The direct `exec_command` still finished before the replacement request, about 2.9 s later. Its output was preserved. |

All cases passed through the public OAR Session methods, with dense record
sequences and the expected native turn count/outcome. The code-mode case
asserts a yielded cell ID and its later result, not merely an accepted steer.

## Unfinished text is still observable

With instant interrupt enabled, the native app-server emitted
`item/started` and a text delta for `unfinished-item`, then proceeded to the
new user message and final answer without an `item/completed` for that old
item. Its partial text was absent from the replacement provider request.

OAR preserved the old delta in its record/event stream, as intended. A UI
must not treat every observed text delta as committed model history, nor
assume every started assistant item receives a completion. OAR's flat text
events do not express an item retraction; native item IDs/lifecycle remain
available in the raw records. An application that needs a reconciled final
transcript needs a separate policy, rather than silently discarding evidence
in the adapter. Upstream's response-preemption implementation explicitly
leaves client item reconciliation as a TODO.

## Opt in and reproduce

For an application choosing this experimental behavior, merge this into the
Codex configuration used by its OAR session, then open a new session:

```toml
[features]
instant_interrupt = true
```

OAR uses the normal Codex home unless the caller supplies a different
`SessionOptions.env.CODEX_HOME`. The long-cell behavior additionally requires
Codex code mode to be enabled; the probe sets `features.code_mode = true`
only for those cases. There is no new OAR environment variable or runtime
default.

```sh
OAR_CODEX_BIN=/path/to/codex-0.159.0 \
  pnpm tsx experiments/codex-instant-interrupt.ts
```

Requires `python3` for the harmless sleep/print tool. Each case uses a fresh
temporary Codex home and cwd and removes them on completion. JSON reports
under `oar-trial-run/codex-instant-interrupt/` retain provider requests and
native OAR records; `summary.json` collects the outcomes. They are local
evidence, not committed fixtures.

This experiment does not verify resume, WebSocket reconnection, retry
backoff, compaction, repeated input during a pending `wait`, or real-model
attention. The upstream PRs cover several of those paths with their own
tests; that is distinct from observation through OAR.

## Primary sources

- [Codex 0.159.0 release](https://github.com/openai/codex/releases/tag/rust-v0.159.0).
- [App-server steering contract](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn): existing `turn/steer`, bound by `expectedTurnId`, without a new turn.
- [PR #48135](https://github.com/openai/codex/pull/48135): opt-in code-mode yielding without stopping the running cell.
- [PR #48141](https://github.com/openai/codex/pull/48141): response preemption, replacement context and the pending client reconciliation work.
- OAR [control mapping](../packages/oar/src/runtimes/codex/session.ts) and [projection](../packages/oar/src/runtimes/codex/projection.ts).
