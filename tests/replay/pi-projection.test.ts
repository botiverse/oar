import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
  foldPiEvent,
  initialPiProjection,
  piPrompted,
  type PiProjectionState,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/pi/projection.js";
import { parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Record/replay for pi. pi has no bare-metal provider here, so the fixture is
 * REAL pi SDK events recorded with a scripted provider (pi-aimock) — same
 * fidelity as the pi-aimock behavior tests; the event SHAPES are pi's own.
 * The recorded events fold through the production projection; the type|commands
 * table snapshots to a FILE beside the input.
 */

const here = import.meta.dirname;
const scenarios = ["tool-round"];

function describeCommand(command: ProjectionCommand): string {
  switch (command.kind) {
    case "begin":
      return "begin";
    case "settle":
      return `settle ${command.outcome.kind}`;
    case "emit": {
      const { body } = command;
      if (body.kind === "tool_call_started") {
        return `emit tool_call_started ${body.tool}`;
      }
      if (body.kind === "reasoning") {
        return `emit reasoning ${body.content.kind}`;
      }
      return `emit ${body.kind}`;
    }
    default:
      return "?";
  }
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
  let state = piPrompted();
  const rows: string[] = [];
  for (const line of lines) {
    const { state: next, row } = foldLine(state, line);
    state = next;
    rows.push(row);
  }
  void initialPiProjection;
  return `${rows.join("\n")}\n`;
}

for (const scenario of scenarios) {
  test(`pi ${scenario}: recorded SDK events fold to the expected commands`, async () => {
    const lines = readFileSync(path.join(here, "fixtures", `pi-${scenario}.raw.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    await expect(foldFixture(lines)).toMatchFileSnapshot(
      path.join(here, "fixtures", `pi-${scenario}.projected.txt`),
    );
  });
}
