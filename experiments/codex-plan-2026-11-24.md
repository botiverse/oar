# Codex plan/checklist notifications

Observed 2026-11-24 on macOS arm64 with `codex-cli 0.171.0`. The provider was
a local scripted Responses stream, so no account, login or model call was
involved; the model's two plan tool calls and its empty list are what the
script sent. OAR opened a real session against that app-server, and the
captured notifications are in
[the selected evidence](codex-plan-2026-11-24.json).

## Result

Codex reports its checklist on the app-server notification
`turn/plan/updated`, one notification per whole list:

```json
{"threadId": "…", "turnId": "…", "explanation": "Two steps to prove the wire",
 "plan": [{"step": "Collect the native facts", "status": "inProgress"},
          {"step": "Write the checklist spec", "status": "pending"}]}
```

Three observations came out in the order the script sent them: a started
list, the same list completed, and then `"plan": []` on the following turn.
`explanation` is present as `null` when the model gave none. The status word
for the step in flight is `inProgress` on this surface, while the model-facing
`update_plan` tool schema captured beside it (the same request's `tools`)
takes `in_progress`; `pending` and `completed` are spelled the same on both.

OAR reads each notification as one `plan_changed` event with
`evidence: "plan_update"`, the turn id as the record's `spanId`, and one event
kind only: no text, user message, task or turn event comes out of a plan
notification. `plan: []` is a reported empty checklist (a clear), not a
missing observation. The tool is off unless configuration enables it; this
probe wrote `[tools.update_plan] enabled = true` into its own `CODEX_HOME`,
and OAR sets no such switch.

Schema corroboration: `codex app-server generate-json-schema` for the same
binary defines `TurnPlanUpdatedNotification` (`plan` and `threadId`/`turnId`
required, `explanation` a nullable string) and `TurnPlanStepStatus` as
`pending` | `inProgress` | `completed`.

## Reproduce

```sh
OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/codex-plan-2026-11-24.ts
pnpm vitest run tests/codex/codex-plan.test.ts
```

## Scope

The probe proves the app-server notification shape, what OAR reads from it and
that replay reads the same facts. It does not show when a real model chooses
to call `update_plan`, whether it keeps one step `inProgress`, or how the
checklist looks after compaction or resume; the tool schema is the model's
only contract for that. `Plan mode` refuses the tool natively ("update_plan is
a TODO/checklist tool and is not allowed in Plan mode"), so no checklist is
reported there.
