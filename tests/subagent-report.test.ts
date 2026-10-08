import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { formatReport, parseReport, type SubagentReport } from "../packages/oar/src/agents/report.js";
import type { TurnOutcome } from "../packages/oar/src/contracts/session.js";

const outcomes = {
  completed: { kind: "completed" },
  aborted: { kind: "aborted" },
  failed: { kind: "failed", failure: "provider", reason: "bad request; session fake (details)\nsecond line [brackets]\n" },
} satisfies { [Kind in TurnOutcome["kind"]]: Extract<TurnOutcome, { kind: Kind }> };

const report: SubagentReport = {
  id: "reviewer-1", name: "reviewer", runtime: "claude", sessionId: "session-1", turn: 2,
  outcome: outcomes.completed, text: "  Findings\n\n[with brackets]\n; session body-text]\n", endedAt: 0,
};

test("parseReport reads the pre-existing header and preserves the body", () => {
  expect(parseReport("[subagent reviewer-1 (reviewer) on claude, turn 2: completed; session session-1]\n  Findings\n\n[with brackets]\n")).toMatchInlineSnapshot(`
    {
      "body": "  Findings

    [with brackets]
    ",
      "id": "reviewer-1",
      "name": "reviewer",
      "outcome": {
        "kind": "completed",
      },
      "runtime": "claude",
      "sessionId": "session-1",
      "turn": 2,
    }
  `);
});

test.each(Object.values(outcomes))("format/parse round trip for $kind, with a verbatim body", (outcome) => {
  const original = { ...report, outcome };
  const formatted = formatReport(original);
  const parsed = parseReport(formatted);
  assert.ok(parsed !== null, formatted);
  expect(parsed).toEqual({
    id: original.id, name: original.name, runtime: original.runtime,
    sessionId: original.sessionId, turn: original.turn, body: original.text,
    outcome: outcome.kind === "failed" ? { kind: "failed", reason: outcome.reason } : outcome,
  });
  const restored: SubagentReport = {
    ...parsed, text: parsed.body, endedAt: 0,
    outcome: parsed.outcome.kind === "failed" ? { ...parsed.outcome, failure: "unknown" } : parsed.outcome,
  };
  expect(formatReport(restored)).toBe(formatted);
});

test("an empty reason and body are preserved without inferring missing metadata", () => {
  expect(parseReport(formatReport({ ...report, name: report.id, outcome: { kind: "failed", failure: "auth", reason: "" }, text: "" }))).toMatchInlineSnapshot(`
    {
      "body": "",
      "id": "reviewer-1",
      "outcome": {
        "kind": "failed",
        "reason": "",
      },
      "runtime": "claude",
      "sessionId": "session-1",
      "turn": 2,
    }
  `);
});

test("a quoted report in the body does not become the outer header", () => {
  const body = `${formatReport(report)}\n${formatReport({ ...report, outcome: outcomes.failed })}`;
  expect(parseReport(formatReport({ ...report, text: body }))?.body).toBe(body);
});

test("names containing spaces, parentheses and Unicode survive", () => {
  const named = { ...report, name: "Review (中文) with spaces" };
  expect(parseReport(formatReport(named))?.name).toBe(named.name);
});

test("an ambiguous parenthesized id follows the legacy id/name convention", () => {
  const { name: _name, ...unnamed } = report;
  expect(parseReport(formatReport({ ...unnamed, id: "x (y)", text: "" }))).toMatchInlineSnapshot(`
    {
      "body": "",
      "id": "x",
      "name": "y",
      "outcome": {
        "kind": "completed",
      },
      "runtime": "claude",
      "sessionId": "session-1",
      "turn": 2,
    }
  `);
});

test.each([
  "ordinary text", "", "[subagent x on claude, turn 1: completed; session s]", "prefix\n[subagent x on claude, turn 1: completed; session s]\nbody",
  "[subagent x on claude, turn 0: completed; session s]\nbody", "[subagent x on claude, turn -1: completed; session s]\nbody",
  "[subagent x on claude, turn 01: completed; session s]\nbody", "[subagent x on claude, turn 9007199254740992: completed; session s]\nbody",
  "[subagent x on claude, turn 1: stopped; session s]\nbody", "[subagent x on claude, turn 1: failed; session s]\nbody",
  "[subagent x on claude, turn 1: completed extra; session s]\nbody", "[subagent x on claude, turn 1: completed; session has space]\nbody",
])("a non-report is refused: %s", (text) => {
  expect(parseReport(text)).toBeNull();
});
