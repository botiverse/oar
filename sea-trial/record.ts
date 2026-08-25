/**
 * Record REAL runtime event streams into replay fixtures. Test infrastructure
 * (needs a real login), not a product feature. Captures the events the adapter
 * consumes, scrubs to the fields the projection reads, and writes
 * tests/replay/fixtures/<runtime>-<scenario>.raw.jsonl.
 *
 *   pnpm sea-trial:record claude <scenario> <prompt> [-- <steer/next prompt>...]
 *   pnpm sea-trial:record codex  <scenario> <prompt> [-- <steer/next prompt>...]
 *
 * Extra prompts after `--` are sent one per turn end (multi-turn) — a leading
 * `+` marks a mid-turn steer (sent ~1.2s in without waiting for the turn to
 * end). The scenario matrix we want: single, multi, steer, compaction, error.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startClaudeRecording } from "./record/claude.js";
import { startCodexRecording } from "./record/codex.js";

const [runtime, scenario, first, ...rest] = process.argv.slice(2);
if (runtime === undefined || scenario === undefined || first === undefined) {
  process.stderr.write("usage: tsx sea-trial/record.ts <claude|codex> <scenario> <prompt> [-- <more>...]\n");
  process.exit(2);
}
const separator = rest.indexOf("--");
const followUps = separator === -1 ? [] : rest.slice(separator + 1);

const recorders = { claude: startClaudeRecording, codex: startCodexRecording };
const record = runtime === "claude" || runtime === "codex" ? recorders[runtime] : null;
if (record === null) {
  process.stderr.write(`unknown runtime: ${runtime}\n`);
  process.exit(2);
}

const raw = await record({ prompt: first, followUps });
const dir = path.join(import.meta.dirname, "..", "tests", "replay", "fixtures");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${runtime}-${scenario}.raw.jsonl`);
writeFileSync(file, `${raw.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
process.stdout.write(`recorded ${raw.length} frames → ${file}\n`);
process.exit(0);
