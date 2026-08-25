/**
 * Record a REAL claude stdout stream into a replay fixture. Test
 * infrastructure, not a product feature — it lives beside sea-trial and needs
 * a real login. Captures each stdout line, scrubs to the fields the projection
 * consumes (dropping machine/session noise so the fixture is a stable, small,
 * readable record of the SHAPE we consume), and writes it under
 * tests/replay/fixtures/<runtime>-<scenario>.raw.jsonl.
 *
 * Usage:  tsx sea-trial/record.ts <scenario> <prompt...>
 *   e.g.  tsx sea-trial/record.ts tool-round "Run bash: echo hi, then confirm."
 *
 * The scenario matrix we want recorded: single-turn, multi-turn, steer,
 * compaction, error. Each is one invocation; the resulting fixture is the
 * committed golden input for tests/replay.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";

const [scenario, ...promptParts] = process.argv.slice(2);
if (scenario === undefined || promptParts.length === 0) {
  process.stderr.write("usage: tsx sea-trial/record.ts <scenario> <prompt...>\n");
  process.exit(2);
}
const prompt = promptParts.join(" ");

const raw: string[] = [];
const child = spawn("claude", [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--dangerously-skip-permissions", "--model", "haiku",
], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length > 0) {
      raw.push(scrub(line));
    }
  }
});

/** Keep only the fields the projection reads. */
function scrub(line: string): string {
  const frame = asRecord(parseJson(line)) ?? {};
  const content = asRecord(frame.message)?.content;
  switch (frame.type) {
    case "system":
      return JSON.stringify({ type: "system", subtype: frame.subtype });
    case "assistant":
      return JSON.stringify({ type: "assistant", message: { content: scrubBlocks(content) } });
    case "user": {
      const blocks = scrubBlocks(content).filter((block) => block.type === "tool_result");
      return JSON.stringify({ type: "user", message: { content: blocks } });
    }
    case "result":
      return JSON.stringify({ type: "result", subtype: frame.subtype, is_error: frame.is_error });
    default:
      return JSON.stringify({ type: frame.type });
  }
}

function scrubBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((raw_: unknown): Record<string, unknown> => {
    const block = asRecord(raw_) ?? {};
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking":
        return { type: "thinking", thinking: block.thinking };
      case "redacted_thinking":
        return { type: "redacted_thinking" };
      case "tool_use":
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      case "tool_result":
        return { type: "tool_result", tool_use_id: block.tool_use_id, content: block.content };
      default:
        return { type: block.type };
    }
  });
}

child.on("exit", () => {
  const dir = path.join(import.meta.dirname, "..", "tests", "replay", "fixtures");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `claude-${scenario}.raw.jsonl`);
  writeFileSync(file, `${raw.join("\n")}\n`);
  process.stdout.write(`recorded ${raw.length} frames → ${file}\n`);
  process.exit(0);
});

child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`);
child.stdin.end();
