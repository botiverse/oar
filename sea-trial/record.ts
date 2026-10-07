/**
 * Record REAL runtime event streams into replay fixtures. Test infrastructure
 * (needs a real login), not a product feature. Captures the events the adapter
 * consumes, scrubs to the fields the projection reads, and writes
 * tests/replay/fixtures/<runtime>-<scenario>.raw.jsonl.
 *
 *   pnpm sea-trial:record claude <scenario> <prompt> [-- <steer/next prompt>...]
 *   pnpm sea-trial:record codex  <scenario> <prompt> [-- <steer/next prompt>...]
 *   pnpm sea-trial:record codex-aimock file-change <prompt>
 *   pnpm sea-trial:record codex-aimock resume <prompt> -- <prompt>...
 *   pnpm sea-trial:record claude-aimock mcp-echo -
 *   pnpm sea-trial:record codex-aimock mcp-echo -
 *
 * `codex-aimock` runs the real codex against a scripted provider (no login,
 * no tokens) whose model applies one patch (record/codex.ts); like pi's, its
 * fixture is named for the runtime, `codex-<scenario>.raw.jsonl`. Its
 * `resume` scenario instead bills each prompt its own usage and runs every
 * follow-up in a new app-server process that resumes the thread. The
 * `mcp-echo` scenario on either aimock runtime records through oar's own
 * session, given SessionOptions.mcpServers (record/mcp.ts); its prompt is
 * scripted, so the one given is ignored.
 *
 * Extra prompts after `--` are sent one per turn end (multi-turn); a leading
 * `+` marks a mid-turn steer (sent ~1.2s in without waiting for the turn to
 * end). The scenario matrix we want: single, multi, steer, compaction, error.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startClaudeRecording } from "./record/claude.js";
import { startCodexAimockRecording, startCodexAimockResumeRecording, startCodexRecording } from "./record/codex.js";
import { startClaudeMcpRecording, startCodexMcpRecording } from "./record/mcp.js";
import { startPiRecording } from "./record/pi.js";

const [runtime, scenario, first, ...rest] = process.argv.slice(2);
if (runtime === undefined || scenario === undefined || first === undefined) {
  process.stderr.write("usage: tsx sea-trial/record.ts <claude|codex|codex-aimock|pi> <scenario> <prompt> [-- <more>...]\n       tsx sea-trial/record.ts <claude-aimock|codex-aimock> mcp-echo -\n");
  process.exit(2);
}
const separator = rest.indexOf("--");
const followUps = separator === -1 ? [] : rest.slice(separator + 1);

const recorders = {
  claude: startClaudeRecording,
  codex: startCodexRecording,
  "codex-aimock": scenario === "resume" ? startCodexAimockResumeRecording : startCodexAimockRecording,
  pi: startPiRecording,
};
const mcpRecorders = { "claude-aimock": startClaudeMcpRecording, "codex-aimock": startCodexMcpRecording };
const mcpRecorder = scenario === "mcp-echo" && (runtime === "claude-aimock" || runtime === "codex-aimock") ? mcpRecorders[runtime] : null;
const record = mcpRecorder ?? (runtime === "claude" || runtime === "codex" || runtime === "codex-aimock" || runtime === "pi" ? recorders[runtime] : null);
if (record === null) {
  process.stderr.write(`unknown runtime: ${runtime}\n`);
  process.exit(2);
}

const raw = await record({ prompt: first, followUps });
const dir = path.join(import.meta.dirname, "..", "tests", "replay", "fixtures");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${runtime.replace(/-aimock$/u, "")}-${scenario}.raw.jsonl`);
writeFileSync(file, `${raw.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
process.stdout.write(`recorded ${raw.length} frames → ${file}\n`);
process.exit(0);
