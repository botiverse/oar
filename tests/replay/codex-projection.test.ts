import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  codexPrompted,
  foldCodexNotification,
  initialCodexProjection,
  type CodexProjectionState,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Record/replay for codex — same shape as the claude test. A REAL recorded
 * codex notification stream (fixtures/*.raw.jsonl from `pnpm sea-trial:record
 * codex ...`, scrubbed to consumed fields) folds through the production
 * projection; the frame|commands table snapshots to a FILE beside the input.
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

function foldLine(state: CodexProjectionState, line: string): { state: CodexProjectionState; row: string | null } {
  const frame = asRecord(parseJson(line));
  const method = typeof frame?.method === "string" ? frame.method : null;
  if (frame === null || method === null) {
    return { state, row: null };
  }
  const { state: next, commands } = foldCodexNotification(state, method, frame);
  const produced = commands.map((command) => describeCommand(command)).join(", ") || "—";
  return { state: next, row: `${method.padEnd(28)} │ ${produced}` };
}

function foldFixture(lines: readonly string[]): string {
  // Seed as if a prompt opened the first turn.
  let state: CodexProjectionState = codexPrompted(initialCodexProjection);
  const rows: string[] = [];
  for (const line of lines) {
    const { state: next, row } = foldLine(state, line);
    state = next;
    if (row !== null) {
      rows.push(row);
    }
  }
  return `${rows.join("\n")}\n`;
}

for (const scenario of scenarios) {
  test(`codex ${scenario}: recorded notifications fold to the expected commands`, async () => {
    const lines = readFileSync(path.join(here, "fixtures", `codex-${scenario}.raw.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    await expect(foldFixture(lines)).toMatchFileSnapshot(
      path.join(here, "fixtures", `codex-${scenario}.projected.txt`),
    );
  });
}
