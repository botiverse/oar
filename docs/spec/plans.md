# Native plan/checklist observation

`plan_changed` is a `RuntimeEventBody`: the checklist a runtime reported,
observed and replayed like any other event. It is observation only. There is
no `Session` member, no session option and no opt-in: a runtime that reports a
checklist reports it whenever its own configuration lets it, and OAR never
asks the model for one, edits one, or runs a plan loop.

```ts
type PlanEvidence = "plan_update" | "tool_call";
type PlanChannel = "native" | "extension";
type KnownPlanStepStatus = "pending" | "in_progress" | "completed";
interface PlanStep { step: string; status: PlanStepStatus; priority?: string }
interface PlanSnapshot { steps: readonly PlanStep[]; explanation?: string }
type PlanEventBody = {
  kind: "plan_changed";
  plan: PlanSnapshot;      // the WHOLE list; every native channel replaces the previous one
  evidence: PlanEvidence;  // which native channel reported it
  callId?: string;         // the tool call that carried it, for evidence: "tool_call"
  channel: PlanChannel;    // the runtime's own channel, or a tool an extension registered
  // Only for `channel: "extension"`, and only from verified facts:
  extension?: { tool: string; source: string; protocol: number };
};
```

A host folds the latest snapshot per agent and shows it beside the
conversation; `[]` steps renders as no checklist.

## Shape and evidence

`plan.steps` is exactly the list the runtime sent, in its order. `step` is
the runtime's own words (codex `step`, ACP and DSH `content`), never trimmed,
summarized or re-worded; `status` keeps the familiar three words and any
status word OAR does not know visibly unchanged; `priority` is present only
when the runtime reported one. `explanation` is the runtime's own account of
the plan, kept only when it gave a non-empty one (codex).

`evidence` separates two different claims about the same-looking list:

- `plan_update`: checklist state the runtime itself tracks and re-sends whole
  (codex `turn/plan/updated`, the ACP `plan` session update).
- `tool_call`: the model's own checklist tool call, read from the complete
  arguments it chose to send (DSH `todo_write`, claude's built-in `TodoWrite`,
  a Pi `TodoWrite` registered by an installed extension). `callId` names that
  call so a host can pair the checklist with the call's own
  `tool_call_started` / `tool_call_ended` records without reading `native`.

`channel` is a second, independent claim: `native` means the runtime's own plan
channel or its own tool; `extension` means a tool an extension registered inside
the runtime.

## Extension-provided checklists

A runtime can track no checklist of its own and still have one, because an
extension loaded into that session registered a tool that reports a list. That
channel is opt-in and verified, never inferred:

- **From the result, not the call.** OAR reads the tool's STRUCTURED RESULT —
  the tool ran and returned — never the arguments a call asked for. A failed
  call (`isError`), an unreadable result, or a call with no result reports no
  checklist.
- **Versioned.** The result carries the contract under `details.oarPlan` with a
  `protocol` OAR must know. OAR reads protocol `1` and nothing else; a result
  written in another version is not reinterpreted.
- **Identity verified in the same session.** `extension.tool` and
  `extension.source` come from the tool report of the session that ran the
  call (`runtime.tools` for a host, the adapter's own report internally): Pi
  names every loaded tool's source ([src] `ToolInfo.sourceInfo`). A tool the
  session did not report, a name reported twice by different sources, or the
  runtime's own builtin of that name all mean NO extension claim — OAR does not
  read a tool name, a runtime version or a file on disk to decide.

```jsonc
// the tool result an extension returns
{ "content": [{ "type": "text", "text": "2 steps" }],
  "details": { "oarPlan": { "protocol": 1,
    "steps": [{ "step": "Read the wire shape", "status": "in_progress" }],
    "explanation": "optional, the tool's own words" } } }
```

`protocol` in the event is the version the result declared, so a host can tell
which contract produced the list. `steps: []` is the tool's own clear. OAR
installs no extension and ships no product logic: a session that loads none
reports nothing here.

## Empty clear, unsupported, and what is never a checklist

An empty list is a fact: `plan: []` (codex), `entries: []` (ACP) and
`todos: []` (DSH) all mean the runtime or model reported no remaining
checklist, which a host renders as cleared. A runtime with no checklist
channel reports nothing at all: no event, no invented empty snapshot, and the
frame still records what it did say. A malformed observation (a `plan` that is
not an array, an entry without its step text or status) stays a native-only
frame for the same reason.

OAR never derives a checklist from prose, from a completed or failed turn,
from `Task` events (background work a runtime tracks beside the turn), or from
a product's own messages. A plan event therefore never becomes transcript
content, never changes `Session.status()`, and never ends or starts a turn.

## Attribution, redaction, and replay

The event inherits its record's envelope: `sessionId` (a derived child session
carries its own), `agentPath`, and — where the runtime gives one — `spanId`
(codex reports the turn id, so an observation attributes to its turn). `native`
holds the frame verbatim, subject to the ordinary credential-field redaction
rules; plan text is model or runtime prose, and no additional field-level rule
is needed or added. A retained record whose `native` was elided keeps its
`events`, so a checklist survived storage bounding. Every event is
re-derivable from the records (`eventsOf`), so live observation and replay
read the same checklists in the same order; a repeated identical list is
reported again rather than deduplicated.

## Runtimes

| Runtime | Native evidence | Read as |
|---|---|---|
| codex | `turn/plan/updated` notification ([env] 0.171.0 capture, [schema] `TurnPlanUpdatedNotification`) | `plan_update`; `inProgress` reads as `in_progress`, other words unchanged; `explanation` when non-empty |
| ACP runtimes (grok, kimi, opencode, qwen, qoder, codebuddy, antigravity, devin, factory) | the standard `session/update` whose `sessionUpdate` is `plan` ([schema] `@agentclientprotocol/sdk` 1.4.0 `Plan`/`PlanEntry`) | `plan_update`; `content` is `step`, `priority` kept when reported; no explanation exists |
| dsh | the model's `todo_write` tool call ([env] captured tool schema) | `tool_call` with `callId`; its `todos` are `step`/`status` |
| claude, cursor, pi, pi-durable, morph | no structured checklist on the adapter's transport | nothing |

The ACP `plan` update is the protocol's own kind, so every ACP runtime carries
it through the same shared projection; no ACP runtime in this repository has
been captured sending one yet, and the two unstable kinds beside it
(`plan_update`, `plan_removed`) are read as nothing.

## Evidence

- Codex [capture](../../experiments/codex-plan-2026-11-24.md) and
  [selected notifications](../../experiments/codex-plan-2026-11-24.json).
- ACP schema capture: [acp-plan-2026-11-24.json](../../experiments/acp-plan-2026-11-24.json).
- DSH tool schema: [evidence/0.2.1-rc.5.json](../../experiments/dsh-plugin/evidence/0.2.1-rc.5.json).
- Tests: [codex](../../tests/codex/codex-plan.test.ts),
  [ACP end to end and schema](../../tests/acp/acp-plan.test.ts),
  [dsh](../../tests/dsh/plan.test.ts).
