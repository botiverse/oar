# raft ↔ oar event parity (coverage, not equal-count)

**Completeness is coverage, not count** (archer): the oar envelope union stays small on
purpose — it is a semantic distillation layer, many raw kinds → few stable envelopes. The
bar is *every raft daemon outbound lifecycle kind has some envelope home*, verified by a
**mechanical parity tooth** (raft adds a new kind → the test auto-reds), paired with the
conformance fixture: **parity proves "all caught," conformance proves "caught correctly."**

⚠️ This table is a **first pass over raft's normalizer raw kinds** (codex/claude/… event
normalizers). The mechanical parity test must pin against raft's *authoritative outbound
type* (the normalized event union the daemon actually ships), not this hand list — that is
the anti-rot guarantee. Homeless rows below are the design questions to close before the
union is frozen.

## FOLD — has a home in the current union

| raft raw kind(s) | oar envelope home | note |
| --- | --- | --- |
| `text` `text_delta` `content_block_delta` `partial` `stream_event` `answer` `assistant` | `text` | streaming/variant of output text |
| `tool_call` `collab_tool_call` `shell` `ls` | `tool_call` | a tool invocation; `name` distinguishes |
| `tool_result` `result`(tool) | `tool_result` | |
| `error` `error_during_execution` `runtime_diagnostic` | `runtime_error` | via `Diagnostic.errorClass` |
| `error_max_budget_usd` | `runtime_error` | needs a `budget_exceeded` DiagnosticClass — currently no class fits (fold **incorrectly** without it) |
| `turn_end` `result`(turn) | `turn_end` | `reason` ∈ completed/interrupted/crashed |
| `reasoning_tokens` `usage` `telemetry` | `turn_end.usage` (metrics) | incremental usage has no mid-turn home (see homeless) |
| `status` | — | status is the *fold output*, never an input event |
| `session_init` `init` `hello` `system` `attrs` `ok` `success` | process-lifecycle / handshake | not turn-level; belongs to the process-lifecycle fold, not this union |

## HOMELESS — no correct envelope yet (close before freezing)

| raft raw kind(s) | problem | proposed disposition |
| --- | --- | --- |
| `reasoning` `thinking` | would fold to `text`, but that erases "thinking vs answering" — a distinction UI and status both use | **conformance call**: either a `reasoning` envelope, or a `text` subtype field. Not a silent fold. |
| `compaction_started` `compacting` `compaction_finished` `compact_boundary` | **no home in the 5** — nothing catches it | **new `compaction` envelope** `{ phase: started \| finished }`. ⭐ Directly relevant to #840 (a remote-compact failure has nowhere to be observed today). |
| `runtime_recovery` | the recovery signal (pairs with the `recovering` status) has no inbound event home | likely `runtime_error`-adjacent or a `recovery` envelope; decide with #840. |
| `task_started` `task_progress` `task_notification` `subagent_progress` `internal_progress` | nested / subagent progress — no home | **new `progress` envelope**? or fold to `text`? — coverage says it needs *a* home. |
| `file_change` | a mutation fact — no home | fold to `tool_result`, or a `file_change` envelope. |
| `review_started` `review_finished` | runtime-specific (review runtime) lifecycle | niche; fold or explicit drop with rationale. |

## 3b — interception, NOT this (3a observation) union

| raft raw kind | note |
| --- | --- |
| `permission` | the host can say *no* — belongs to 3b (interception), whose contract needs a latency budget and timeout-default. Never folded into a 3a observation envelope. |

## Next

1. Pin the **authoritative raft outbound kind list** (the normalized union, not this hand
   list) and wire the mechanical parity test against it — raft adds a kind → red.
2. Close each homeless row (fold-target vs new envelope) — `compaction` is the clearest
   new envelope; `reasoning` is the clearest conformance call.
3. Re-freeze the union once every raft kind has an asserted home + the conformance fixture
   proves the semantically-important ones are lifted correctly.
