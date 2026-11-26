# Candidate acceptance — official v0.134.0, 2026-11-26

What was merged, what was verified, what is left. Ordering follows the request
that drove this round: the v0.134.0 merge first, then the capability pass, then
the acceptance evidence.

## 1. The merge

| | commit |
|---|---|
| official release merged | `v0.134.0` (`ee3de8db`), on top of `v0.131.0` |
| merge commit | `28a3e4b4` |
| candidate capability work | `efd4923c` |
| procedure + artifacts | `217f8aaf` (GitLab `main`) |

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
  channel (the shape Hikari pins), while `userQuestions` is gated by each
  runtime's declared refusal, as upstream does. Hermes declares that refusal.

Lint debt the candidate carried was also cleared (two files over the line
budget, one type assertion, one brace), so all four gates are green.

## 2. Capabilities

`plan`/TODO was the one capability official OAR did not cover for the engines
Hikari runs. It is implemented here rather than in Hikari UI:

| engine | checklist source | evidence |
|---|---|---|
| codex | `turn/plan/updated` | `plan_update`, `channel: "native"` |
| claude | built-in `TodoWrite` tool call (verified in the installed 2.1.332 binary) | `tool_call`, `channel: "native"` |
| dsh | `todo_write` tool call | `tool_call`, `channel: "native"` |
| grok, hermes and every ACP runtime | ACP `session/update` `plan` | `plan_update`, `channel: "native"` |
| pi | the `TodoWrite` tool the installed `hikari-todo-write.ts` extension registers — reused, not reinvented | `tool_call`, `channel: "extension"` |
| cursor, pi-durable, morph | none | no event, never an invented empty list |

`PlanEventBody.channel` (`native` | `extension`) is the native/plugin
distinction the request asked for. OAR reports `extension` only for a call the
runtime actually executed, and fills `extension` identity (tool + source) only
from what the runtime itself reported: Pi's inventory now carries
`ToolEntry.source` from `ToolInfo.sourceInfo`, which is where a host verifies
the plugin. Nothing is claimed from a file on disk or from a version.

Everything else was already in the candidate and survived the merge unchanged:
Hermes generic ACP runtime with advertised current-turn steering and text-only
steering with local image paths, DSH provider/images/reasoning, Pi
provider/compaction over RPC, Grok reasoning controls, host-owned queue
snapshots with evidence-gated restore, plan observation, and the claude
host-answered approval/question round-trips.

### Per-engine state (verified from the runtime declarations and code)

| engine | steer | approvals (`answer`) | questions | fork | compaction | context |
|---|---|---|---|---|---|---|
| claude | native | none (by design) | `"ask"` and `"host"` | native | native | full breakdown |
| codex | native | none | `"host"` | native | native | tokens + window |
| pi | native (SDK + RPC) | none | refused (no channel) | refused (no verified native fork) | native | tokens + window |
| dsh | `agent.steer` | none | refused | refused | native | tokens + window |
| grok | `_x.ai/interject` | none | refused | refused | native | tokens only, see below |
| hermes | advertised `_hermes/session/steer` | none | refused | native | declared unsupported | tokens + window |

No adapter exposes `Session.answer`: approvals are never host-answered, and a
runtime that routes a non-question approval to the question gate gets a native
deny. That is the fail-closed behavior Hikari's worker asserts
(`no vendor adapter hands approvals to the host`).

## 3. Verification

| gate | result |
|---|---|
| `pnpm run typecheck` (oar, cli, root, pi-durable) | clean |
| `pnpm run lint` (oxlint type-aware, deny warnings) | clean |
| `pnpm run test` | 594 files / 5,834 passed, 8 skipped |
| `CI=1 npx tsx sea-trial/main.ts` (mock) | 21 passed, 1 skipped, 0 failed |
| `pnpm run build` | clean (oar + cli) |
| Hikari worker suite against the candidate tarball | 131 assertions passed, 2 failed — both version pins |

The Hikari worker run used a copy of `tools/hikari-oar-worker` with only the
vendored `@botiverse/oar` replaced by
`artifacts/oar-0.134.0-candidate-efd4923c.tgz` (the Hikari checkout was not
modified). What that proves:

- the installed OAR event union still matches Hikari's per-kind disposition
  table — no kind was added or removed by the merge;
- the question channel is still opt-in and capability-gated, and only claude
  declares it;
- no adapter hands approvals to the host;
- Pi provider/compaction, MCP tool mounting, Grok MCP and the launch/refusal
  contract all pass.

The two failures are the pins that name the candidate explicitly:
`docs/oar-event-dispositions.json` pins `0.131.0` and the provenance test pins
the vendored tarball. Both are Hikari-side bumps, listed below.

## 4. Left for Deploy: what a Hikari change must do

1. Replace `tools/hikari-oar-worker/vendor/oar-0.131.0-candidate-9511944a.tgz`
   with `artifacts/oar-0.134.0-candidate-efd4923c.tgz` and its provenance
   file, and repin `dependencies["@botiverse/oar"]`.
2. Bump the version pinned in `docs/oar-event-dispositions.json` to `0.134.0`
   (no new event kinds, so only the version line moves).
3. Re-run `cd tools/hikari-oar-worker && npm test`; the two pinning tests above
   are the ones expected to change state.

Nothing in the Java layer has to change for this candidate: the worker protocol,
the question/queue/plan contracts and the refusal map Hikari reads are
unchanged in shape.

## 5. Known limits, deliberately not faked

- **Grok context window.** `session/new` advertises `totalContextTokens` per
  model, but no answer carries a window, so `contextWindow`/`percent` stay
  `null` for Grok. Filling it from the open answer would go stale on a model
  switch, so it stays a documented gap rather than an estimate.
- **Pi fork** stays refused: no verified native fork that opens a copy under a
  new id.
- **Hermes manual compaction** stays `unsupported`: `/compress` exists in its
  command list but has no structured completion or attribution contract.
- **Hikari Java tests** were not run: they exercise the vendored 0.131.0
  package in the Hikari checkout, which this task may not modify. The worker
  suite above is the gate that covers the same contract.
- One upstream test (`tests/opencode/background-child.test.ts`) flaked once
  under full-suite load and passes in isolation; it is a real-binary timing
  test, not a merge regression.
