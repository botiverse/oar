# Candidate acceptance — official v0.134.0, 2026-11-26

What was merged, what the review corrected, what was verified, what is left.

## 1. The merge

| | commit |
|---|---|
| official release merged | `v0.134.0` (`ee3de8db`), on top of `v0.131.0` |
| merge commit | `28a3e4b4` |
| candidate capability work | `efd4923c` |
| extension checklist corrected | see below |
| procedure + artifacts | `docs/development/candidate-integration.md`, `artifacts/` |

v0.134.0 brought four things: v0.132.0 service-tier fallback and unattended MCP
elicitation decline, v0.133.0 the cursor `childProcess` launcher, and v0.134.0
opencode v2 per-model metadata plus #1189 host-answered user questions.

Two releases shipped a second implementation of a capability this candidate
already had (host-answered questions). Both were kept, with one seam:

- `Session.answerQuestion` accepts either answer dialect (`HostQuestionAnswer`:
  the candidate's `AppQuestionAnswers` and the release's `UserQuestionAnswer`)
  and returns the vocabulary of the option that opened the session —
  `QuestionAnswerOutcome` for `questions: "ask"`, `AnswerQuestionOutcome` for
  `userQuestions: "host"`. Giving both options is refused.
- claude keeps both launch shapes: `questions: "ask"` stays read-only
  (`--permission-mode default --permission-prompt-tool stdio`, every other
  `can_use_tool` denied natively); `userQuestions: "host"` keeps the release
  bypass-permission shape. Neither replaces the other.
- The v0.132.0 unattended MCP elicitation decline had been dropped by the
  candidate's own `appRequestResponse` wiring; it is restored for every claude
  session.
- `defineRuntime` still refuses `questions` on a runtime without a verified
  channel, while `userQuestions` is gated by each runtime's declared refusal, as
  upstream does. Hermes declares that refusal.

## 2. What the review corrected

The first cut of the Pi checklist read a tool call at `tool_execution_start`
from the tool's NAME plus the requested arguments. That claimed an extension
from a name alone: an unrelated tool of that name, a call that later failed, or
a session that never loaded the extension all produced a checklist.

It is replaced by an opt-in, verified contract ([plans](../spec/plans.md#extension-provided-checklists)):

- OAR reads the tool's **structured result** (`details.oarPlan`, protocol `1`),
  never the arguments, and never a failed call (`isError`).
- The **identity** (`tool`, `source`) comes from the tool report of the same
  opened session, in both execution modes: the in-process session reads
  `getAllTools()`; the RPC child sends the same list over its private pipe at
  session start and refreshes it each turn, and the parent keeps the latest per
  session so concurrent sessions never share a report.
- A tool the session did not report, a name reported twice by different
  sources, or Pi's own builtin of that name means **no** extension claim.
  Nothing is inferred from a name, a version, or a file on disk, and OAR
  installs no extension.
- The event carries `extension: { tool, source, protocol }`, where `protocol` is
  the version the result itself declared.

Native plan events are untouched and separate: codex `turn/plan/updated`, the
ACP `session/update` `plan`, DSH's `todo_write` call and claude's built-in
`TodoWrite` call all still report `channel: "native"`.

Product references were also removed from package source, fixtures and public
docs: the candidate carries no product naming and no product logic.

## 3. Per-engine state (from the runtime declarations and code)

| engine | steer | approvals (`answer`) | questions | fork | compaction | context |
|---|---|---|---|---|---|---|
| claude | native | none (by design) | `"ask"` and `"host"` | native | native | full breakdown |
| codex | native | none | `"host"` | native | native | tokens + window |
| pi | native (SDK + RPC) | none | refused (no channel) | refused (no verified native fork) | native | tokens + window |
| dsh | `agent.steer` | none | refused | refused | native | tokens + window |
| grok | `_x.ai/interject` | none | refused | refused | native | tokens only, see below |
| hermes | advertised `_hermes/session/steer` | none | refused | native | declared unsupported | tokens + window |

No adapter exposes `Session.answer`, and only claude declares a question
channel. A runtime that routes a non-question approval to the question gate gets
a native deny (`tests/claude/claude-question.test.ts`: "a tool approval the gate
also routes is denied and recorded, never granted").

## 4. Verification

| gate | result |
|---|---|
| `pnpm run typecheck` (oar, cli, root, pi-durable) | clean |
| `pnpm run lint` (oxlint type-aware, deny warnings) | clean |
| `pnpm run test` | 594 files / 5,842 passed, 8 skipped |
| approval/question fail-closed checks | 64 passed (`claude-question`, `app-request-question`, `app-request-answer`, `app-request-cancelled`, `app-requests`, `refused-session-options`) |
| declaration probe | adapters answering approvals: none; declaring a question channel: claude only |
| `pnpm run build` | clean (oar + cli) |
| Pi plan suite | 9 tests: success, clear, arguments-only, no report, other plugin, builtin, duplicate source, failure, foreign protocol, concurrent sessions, report shape |
| RPC private pipe | 7 tests, including the child's tool report and an unreadable report |

## 5. Left for a host to accept

1. Swap the vendored package for `artifacts/oar-0.134.0-candidate-<sha>.tgz`
   and its provenance file, and repin the dependency.
2. Bump the version pinned in the worker's event-disposition table to `0.134.0`
   (no event kinds were added or removed).
3. Re-run that worker's own suite; only its version-pinning assertions change
   state.

## 6. Known limits, deliberately not faked

- **Grok context window.** `session/new` advertises `totalContextTokens` per
  model, but no answer carries a window, so `contextWindow`/`percent` stay
  `null` for Grok. Filling it from the open answer would go stale on a model
  switch, so it stays a documented gap rather than an estimate.
- **Pi fork** stays refused: no verified native fork that opens a copy under a
  new id.
- **Hermes manual compaction** stays `unsupported`: `/compress` exists in its
  command list but has no structured completion or attribution contract.
- A tool an extension registers *after* its result was already folded reports
  no checklist for that call; the refresh is per turn, so the next turn sees it.
