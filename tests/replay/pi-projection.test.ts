import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
  foldPiEvent,
  initialPiProjection,
  piAbortRequested,
  piPrompted,
  type PiProjectionState,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/pi/projection.js";
import { parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Record/replay for pi. pi has no bare-metal provider here, so the fixture is
 * REAL pi SDK events recorded with a scripted provider (pi-aimock) — same
 * fidelity as the pi-aimock behavior tests; the event SHAPES are pi's own.
 * The recorded events fold through the production projection; the
 * type|record table snapshots to a FILE beside the input. Every SDK event
 * yields exactly one event record (v2: nothing is dropped); the views column
 * is what oar read out of it.
 */

const here = import.meta.dirname;
const scenarios = ["tool-round"];

function describeCommand(command: ProjectionCommand): string {
  const views = command.body.views.map((view) => {
    if (view.kind === "tool_call_started") {
      return `tool_call_started ${view.tool}`;
    }
    if (view.kind === "reasoning") {
      return `reasoning ${view.content.kind}`;
    }
    if (view.kind === "turn_ended") {
      return `turn_ended ${view.outcome.kind}`;
    }
    if (view.kind === "usage") {
      return view.usage.tokens === undefined ? "usage" : `usage in=${String(view.usage.tokens.input)} out=${String(view.usage.tokens.output)}`;
    }
    return view.kind;
  });
  return `event${views.length === 0 ? "" : ` → ${views.join(", ")}`}`;
}

function parseEvent(line: string): AgentSessionEvent {
  // oxlint-disable-next-line consistent-type-assertions, no-unsafe-type-assertion -- the fixture is a recorded pi SDK event stream, replayed verbatim
  return parseJson(line) as AgentSessionEvent;
}

function foldLine(state: PiProjectionState, line: string): { state: PiProjectionState; row: string } {
  const event = parseEvent(line);
  const { state: next, commands } = foldPiEvent(state, event);
  const produced = commands.map((command) => describeCommand(command)).join(", ") || "—";
  const label = event.type === "message_update" ? `${event.type}:${event.assistantMessageEvent.type}` : event.type;
  return { state: next, row: `${label.padEnd(30)} │ ${produced}` };
}

function foldFixture(lines: readonly string[]): string {
  let state = piPrompted(initialPiProjection);
  const rows: string[] = [];
  for (const line of lines) {
    const { state: next, row } = foldLine(state, line);
    state = next;
    rows.push(row);
  }
  return `${rows.join("\n")}\n`;
}

for (const scenario of scenarios) {
  test(`pi ${scenario}: recorded SDK events fold to the expected records`, async () => {
    const lines = readFileSync(path.join(here, "fixtures", `pi-${scenario}.raw.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    await expect(foldFixture(lines)).toMatchFileSnapshot(
      path.join(here, "fixtures", `pi-${scenario}.projected.txt`),
    );
  });
}

test("pi agent_settled carries the adapter-supplied context and classifies abort and provider errors", () => {
  const agentEnd: AgentSessionEvent = { type: "agent_settled" };
  const context = { tokens: 42, contextWindow: 1000, percent: 4 };
  const completed = foldPiEvent(piPrompted(initialPiProjection), agentEnd, { context });
  expect(completed.commands[0]?.body.views).toEqual([
    { kind: "turn_ended", outcome: { kind: "completed" } },
    { kind: "usage", usage: { context } },
  ]);
  const aborted = foldPiEvent(piAbortRequested(piPrompted(initialPiProjection)), agentEnd);
  expect(aborted.commands[0]?.body.views).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
  const errored = foldPiEvent(piPrompted(initialPiProjection), {
    type: "turn_end",
    // oxlint-disable-next-line consistent-type-assertions, no-unsafe-type-assertion -- only the fields the fold reads matter here
    message: { role: "assistant", stopReason: "error", errorMessage: "400 bad request" } as never,
    toolResults: [],
  });
  const ended = foldPiEvent(errored.state, agentEnd);
  expect(ended.commands[0]?.body.views[0]).toEqual({
    kind: "turn_ended",
    outcome: { kind: "failed", reason: "400 bad request", failure: "invalid_request" },
  });
});
