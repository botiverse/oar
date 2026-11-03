# Manual compaction follow-up: 2026-11-02

Grok, Qoder, Cursor and OpenCode v2 can expose the existing optional
`Session.compact()` control without treating an ordinary successful prompt
as proof of compaction. This extends the
[first implementation](manual-compaction-2026-11-02.md). Pi Durable remains
outside this change; its 1.5 migration is separate.

All native observations below are Linux x64. The Grok and OpenCode provider
is local aimock; Qoder uses its native replay transport and a synthetic
identity. Cursor is the exception: a small, explicitly retained experiment
used the existing real account. No real-account run belongs in check or CI.
The versions actually exercised are Grok 1.0.70, Qoder 1.1.81, OpenCode v2
2.2.5 and Cursor SDK 1.2.0. OpenCode v1 1.19.5 is the negative capability
control. This is versioned evidence, not a claim about every future binary.

## Results and ownership

| Runtime | Native entry and completion | Failure, cancellation and empty history |
| --- | --- | --- |
| Grok | `_x.ai/compact_conversation` replies `{}` after completion. Its reply directly answers this request; no start event or manual trigger is inferred. | Structured `RequestError.data.kind` reports `compact_failed` or `compact_cancelled`. Empty history returns `{}` as a native no-op. Other RPC errors refuse execution without a compaction end. Null replies release the gate as unconfirmed; transport loss without a native answer remains reserved. |
| OpenCode v2 | ACP `/compact` emits `_meta["opencode/compaction"]` start/end with a shared `messageId`. A matching terminal marker proves compaction. The prompt RPC answer releases the gate and status together; absent evidence yields unconfirmed rather than retaining a known-finished operation. | Provider failure, empty history and an invalid summary all report failed compaction even though the ordinary prompt returns `end_turn`. Native cancellation reports an aborted marker and a cancelled prompt. |
| Qoder | `/compact` is a command with an exact `command_uuid`. Started lifecycle, manual `compact_boundary` and the matching terminal lifecycle delimit the operation; an ordinary result is independent and can be absent. | Empty history ends successfully as a command but has no boundary: `compact()` returns `failed/not_compacted`. A completed boundary remains completed if a cancelled lifecycle arrives later. |
| Cursor | `Agent.summarize()` returns a native run. A root summary terminal status with that run id, followed by its terminal `run.wait()` result, proves completion. | Empty history is refused by the SDK. A cancelled run without a terminal summary returns aborted without inventing `compaction_ended`. Lost observation stays unconfirmed; a known terminal run without a summary releases the input gate but cannot establish completed compaction. |

OpenCode v1 still has no `compact` session member. The common OpenCode
Runtime spans v1 and v2 and therefore remains undeclared rather than
advertising the v2 capability for v1 installations. Grok, Qoder and Cursor
advertise support with `activeTurn: "reject"`; the session remains the
final authority (for example, a host Cursor SDK stand-in may omit summarize).
All four reject active work and do not implicitly abort it to compact.

### Command provenance

The same-name command controls configure both `compact` and an ordinary
`oar-proof` command. The native catalog must contain the latter, proving
the command configuration was loaded. The subsequent compact still produces
native compaction evidence. OpenCode also asserts that the custom compact
template never reached the scripted provider. This is stronger than merely
creating a file and observing an unchanged result.

OpenCode's exact v2.2.5 source agrees with the observation:
[`catalog.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/acp/catalog.ts)
filters builtin names out of user commands;
[`prompt.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/acp/prompt.ts)
marks builtin compact separately, and
[`turn.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/acp/turn.ts)
submits compaction before custom command dispatch. The adapter does not
implement a second command parser or substitute a hidden prompt.

Qoder's command result carries no input UUID. The correlation therefore
requires its matching command lifecycle and an exclusive idle interval;
it cannot borrow a boundary from a child, another command or automatic
compaction. This does not establish attribution for native queued compact
commands, so busy calls remain rejected.

### Cancellation is a separate observation

Qoder's cancellation control returned an accepted abort receipt. Its
sequence was compacting status, completed manual boundary, an ordinary
successful result, then a cancelled command lifecycle. The last lifecycle
does not erase the boundary. Conversely, a cancelled command without a
boundary returns aborted. Neither outcome is inferred from human-readable
error text.

OpenCode's metadata, not `stopReason: end_turn`, decides whether it
compacted. The failed/empty/invalid-summary controls deliberately preserve
this discrepancy. Native error types `aborted` and `compaction.interrupted`
are cancellation in the exact version's
[projection source](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/acp/compaction.ts);
the live cancellation sample reports `aborted`. The second enum is pinned
by a source-shaped unit counterexample, not claimed as a second live sample.

Grok's manual request also emits an `auto_compact_completed` notification.
Its name is not a manual/automatic provenance contract. The implementation
uses the correlated RPC reply and leaves that notification raw.

### Replayable identities

The additional optional fields represent distinct facts:

- `compactionId` on start/end is the native compaction identity. OpenCode's
  `messageId` is projected for automatic as well as manual events.
- `spanId` on the envelope is a native turn/run identity. Cursor's stream
  `run_id` and terminal result `id` populate it; `onDelta` uses the id of
  its returned run too, buffering callbacks that arrive before that id while
  preserving their ingress time. It is
  not a message id.
- `compaction_ended.requestId` identifies the OAR request answered by a native
  response. Grok can report completion without an observed start.
- `FrameBody.responseTo` explicitly correlates a native answer or command
  terminal with an OAR request by identifiers, never timing. It also survives
  null answers or RPC refusals without manufacturing compaction events.
- `compact.settledBy: "native_response"` tells the fold to remain occupied
  until that response. Grok, OpenCode and Qoder use it; Qoder keeps both its
  ordinary result and manual boundary at their original positions.
- `accepted.queued: "adapter"` retains ACP queue ownership. Actual dispatch
  records one new prompt with `carries` (input id, otherwise queue request id)
  and one response. Withdrawal removes the held entry; no second response is
  added to the queue request. The gap before dispatch remains visibly busy.

The fold learns an OpenCode manual operation's identity from the first
native manual start inside the exclusive idle operation. The complete
public `StatusState` checkpoint retains it. Wrong, old or absent ids cannot
prove completion; neither can an automatic end. Matching native terminal
evidence is evaluated at the correlated response, which releases the gate
even when completion could not be confirmed. JSON checkpoint regressions
cover that response and adapter-held queue ownership.
For Cursor, the accepted response carries the native run id before its
summary frames are processed, including cancellation before any start.

Cursor retains its root envelope `sessionId` and existing task/agentPath
attribution. Native `agent_id` remains in the payload and must match the
root for a summary to prove compaction. Run spans also appear on ordinary
callback and stream frames.
The native payloads are unchanged. A lost SDK wait is recorded diagnostically
without an artificial terminal event for the manual operation, so the fold
stays compacting while its outcome is unknown.

## Cursor account scope and usage

The SDK 1.2.0 experiment used the existing local Cursor account with
`gpt-5.4-nano`, no tools, one seed prompt, an empty-history refusal, one
completed summary and one summary cancelled after its native running status.
The ordinary seed turn reported input **3,341**, output **40** (including
reasoning **31**), cache read/write **0**. Summary runs did not provide complete
usage. These numbers are **not the experiment total** and are not a cost
estimate. Account identity, conversation text and local paths are omitted
from the selected evidence.

Future real-account probes require prior confirmation of cases, rounds and
model, followed by a usage report. This retained script is manual evidence,
not an automatic fallback when an SDK fixture fails. Routine tests use a
credential-free SDK stand-in, including late startup after disposal,
wrong run/session ids, missing terminal summaries and stream/wait failures.

### Restored Cursor active-run limitation

The additional [offline SDK storage probe](cursor-summarize-force-offline.ts)
uses SDK 1.2.0's real isolated store and resume path, a synthetic model/key,
and a stubbed model catalog. It seeds a saved checkpoint and an active run,
then invokes public `summarize()` with no argument and with an ignored
`local.force` argument. Both refuse with `UnknownAgentError` and the native
message `Agent <agent> already has active run`; the run remains active.
No executor or fetch call occurs. This tests persisted ownership, not a real
crashed executor. [Selected output](manual-compaction/cursor-force-offline.json)
contains no account or local-path data.

The 1.2.0 declaration accepts no summarize options, and its implementation
calls the shared send implementation with empty options. OAR cannot forward
`local.force` through that public method. It preserves the typed native
refusal instead of using a private send method or expiring a native run.
Run the probe with `pnpm tsx experiments/cursor-summarize-force-offline.ts`;
it never invokes the retained real-account script.

## Reproduction and retained evidence

[Selected JSON](manual-compaction/followup-selected.json) retains native
outcomes and relevant ordered frames. Random identifiers are aliased per
source while preserving equality; native field names and enum values are
unchanged. Conversation/account fields are intentionally not selected.

Use installed versions matching the table, through `OAR_GROK_BIN`,
`OAR_OPENCODE_BIN` and `OAR_QODER_BIN`. The native scripts below all isolate
configuration and use synthetic model responses:

```sh
pnpm tsx experiments/manual-compaction/acp-lifecycle.ts grok /tmp/manual-compaction-grok-lifecycle.json
pnpm tsx experiments/manual-compaction/acp-lifecycle.ts opencode /tmp/manual-compaction-opencode-lifecycle.json
pnpm tsx experiments/manual-compaction/opencode-v2.ts /tmp/manual-compaction-opencode-v2-final.json
pnpm tsx experiments/manual-compaction/qoder-lifecycle.ts /tmp/manual-compaction-qoder-lifecycle.json
python experiments/manual-compaction/select-followup-evidence.py INPUT_DIR OUTPUT.json
```

The selector also reads `manual-compaction-cursor-control/selected.json`,
produced by the separate, real-account
[Cursor script](manual-compaction/cursor-control.ts). Obtain confirmation
before running that script. Existing selected evidence does not require
rerunning it.

`sea-trial/vendor/manual-compaction-followup.vendor.test.ts` drives the
public controls against real Grok/OpenCode/Qoder with synthetic responses.
It covers same-name commands, empty history, native failure/cancellation,
caller timeouts and queued input. OpenCode v2 cases run only with an actual
v2 installation; ordinary v1 CI must skip them. Dedicated unit tests pin
identity, queue order, late replies, disposal and transport-loss boundaries.

## Validation boundary

The revised full check passed 3,122 tests and 18 mock behavior checks. Existing
replay snapshots required no updates. Fourteen review counterexamples were
caught: Cursor's early unhandled rejection, Grok RPC classification,
OpenCode missing-proof release/error frames/usage, Qoder terminal release,
exact response identity, adapter queue acceptance, early Cursor callback
spans, ordinary Claude/Codex/Cursor terminal reentry, and Grok/OpenCode
admission before dispatch. Each mutation was reverted. Two additional
before/after regressions pin startup-refusal reentry and buffered callback
ingress time. The initial seven identity/ownership counterexamples remain
covered by their committed regressions.

All 14 existing behavior backends passed. Full native vendor runs passed
for Claude (80 tests), Codex (62), Qoder (12), Grok (20) and OpenCode v1 (10).
Pi SDK and RPC 1.5.0 passed all 16 manual compaction controls. The six new
OpenCode v2 compaction controls passed; all six explicitly skip with v1.
Build and clean packed-host installation passed, including optional peers
and public type exports. Routine Cursor controls and the added SDK storage
probe require no credentials. Native evidence remains local Linux x64;
Windows and macOS results depend on the revised pull-request CI.

An additional, deliberately broader run of the existing OpenCode vendor
suite with v2 failed five MCP cases: three in `mcp-servers-acp`, one in
`mcp-tools-list-changed`, and one in `serve-mcp-tools`. Running those same
files on the unchanged base `4bf1e23b` reproduced the same five failures.
Those tests are written for the v1 direct MCP/prompt protocol, as
[the harness README](../sea-trial/README.md) documents. This change does not
alter them or claim the whole v2 vendor suite passes. The v2 acceptance
scope is the new compaction controls and the directly related native probes;
no diagnosis of the separate cold-resume MCP issue is inferred here.

## Release-note draft

Optional manual compaction extends to Grok, Qoder and Cursor, and to sessions
using OpenCode v2. Active work must finish first. OpenCode v1 remains
unsupported; Pi Durable is deferred to its native API migration. Caller
cancellation stops waiting and does not claim that native compaction stopped.

Compaction events may carry native `compactionId` and directly correlated
OAR `requestId`. Frames gain `responseTo`; Grok/OpenCode/Qoder compact requests
gain `settledBy: "native_response"`. ACP queue acceptance gains
`queued: "adapter"`, with a carried prompt recorded at actual dispatch.
This changes ordinary adapter-held queues too, for Kimi, Grok, OpenCode,
Antigravity and CodeBuddy. Hosts counting requests or grouping by kind must
distinguish that extra prompt from a new host input: `carries` identifies the
already accepted input, so queue plus dispatch is one logical submission.
Qoder uses stream-json and keeps its existing queue records.
These additive fields keep status and input admission aligned, including
native refusals, missing completion evidence and the held-queue gap.
Incremental status consumers must preserve the complete `StatusState`.
Cursor frames retain the existing root session/child-task attribution while
adding native run spans to callbacks and stream frames. SDK 1.2.0 summarize
cannot forward `local.force` for a restored active run.

Bug fix affecting ordinary Claude, Codex and Cursor turns as well as compact:
a synchronous `turn_ended` observer can immediately send the next prompt.
Internal ownership is released before publishing that same terminal frame,
and old cleanup cannot clear the new turn. The native frame content and
relative frame order are unchanged by this sequencing fix. All three ordinary
paths and the compact boundaries have direct observer-reentry regressions.
The same rule covers startup refusal: the compact reservation releases before
external observers see its rejected response restore idle.
