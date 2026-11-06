/** Linux inventory: tsx experiments/acp-terminal-priority.ts <runtime> <output.json>. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { probeTerminalPriority } from "../sea-trial/harness/acp-terminal-priority.js";

const id = process.argv.at(2);
assert.ok(id === "grok" || id === "kimi" || id === "opencode" || id === "antigravity" || id === "codebuddy");
const result = await probeTerminalPriority(id);
const json = `${JSON.stringify(result, null, 2)}\n`;
await writeFile(path.resolve(process.argv.at(3) ?? `oar-trial-run/${id}-priority.json`), json);
process.stdout.write(json);
