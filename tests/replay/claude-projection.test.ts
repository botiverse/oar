import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  claudePrompted,
  foldClaudeStdout,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Record/replay: fold a REAL recorded claude stdout stream (fixtures/*.raw.jsonl,
 * captured from a live login by `pnpm sea-trial:record`, scrubbed to consumed
 * fields) through the production projection fold and snapshot the result as a
 * FILE beside the input — input is a file, so the output is too. The snapshot
 * shows each raw frame next to the kernel commands it produced: the living
 * "what the provider sends → how we project it" specimen and a regression net.
 */

const here = import.meta.dirname;
const scenarios = ["tool-round", "multi-turn"];

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

function summarizeFrame(message: { type?: string; subtype?: string; message?: { content?: { type?: string }[] } }): string {
  const blocks = message.message?.content?.map((block) => block.type).join(",") ?? "";
  return [message.type, message.subtype, blocks].filter((part) => part !== undefined && part !== "").join(" ");
}

function foldFixture(lines: readonly string[]): string {
  // Seed as if a prompt opened the first turn (the control-plane input the
  // recorded stdout stream does not itself carry).
  let state = claudePrompted();
  const rows: string[] = [];
  for (const line of lines) {
    const message = asRecord(parseJson(line));
    if (message !== null) {
      const { state: next, commands } = foldClaudeStdout(state, message);
      state = next;
      const produced = commands.map((command) => describeCommand(command)).join(", ") || "—";
      rows.push(`${summarizeFrame(message).padEnd(28)} │ ${produced}`);
    }
  }
  return `${rows.join("\n")}\n`;
}

for (const scenario of scenarios) {
  test(`claude ${scenario}: recorded stdout folds to the expected commands`, async () => {
    const lines = readFileSync(path.join(here, "fixtures", `claude-${scenario}.raw.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    await expect(foldFixture(lines)).toMatchFileSnapshot(
      path.join(here, "fixtures", `claude-${scenario}.projected.txt`),
    );
  });
}
