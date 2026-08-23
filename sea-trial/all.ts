// Run several backends CONCURRENTLY — each is its own process (backend env
// setup is process-scoped by design, so processes are the isolation unit).
// One invocation = one run directory (see harness/trace.ts): every backend's
// trace and full output land together, plus a machine-readable report.json.
// Stdout carries only grouped per-backend summaries.
// Usage: tsx sea-trial/all.ts [backend...]   (default: mock + the aimocks)
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRunDir } from "./harness/trace.js";

const backends = process.argv.slice(2);
const targets = backends.length > 0 ? backends : ["mock", "claude-aimock", "codex-aimock", "pi-aimock"];
const runDir = resolveRunDir();

const results = await Promise.all(targets.map(async (target) => {
  const backendDir = path.join(runDir, target);
  mkdirSync(backendDir, { recursive: true });
  const log = createWriteStream(path.join(backendDir, "output.log"));
  const result = await new Promise<{ target: string; code: number | null; summary: string[] }>((resolve) => {
    const child = spawn("pnpm", ["run", "sea-trial"], {
      env: { ...process.env, OAR_TEST: target, OAR_TRIAL_RUN_DIR: runDir },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const summary: string[] = [];
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      log.write(text);
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (/^(?:FAIL |SKIPPED )|clean$|— skipping$/u.test(line)) {
          summary.push(line);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      log.write(chunk.toString());
    });
    child.on("exit", (code) => {
      log.end();
      resolve({ target, code, summary });
    });
  });
  return result;
}));

writeFileSync(path.join(runDir, "report.json"), `${JSON.stringify({ runDir, results }, null, 2)}\n`);
for (const result of results) {
  process.stdout.write(`── ${result.target} ${result.code === 0 ? "✓" : "✗"}\n`);
  for (const line of result.summary) {
    process.stdout.write(`   ${line}\n`);
  }
}
const failed = results.filter((result) => result.code !== 0);
process.stdout.write(`artifacts: ${runDir}\n`);
process.stdout.write(failed.length === 0
  ? `all ${results.length} backends clean\n`
  : `FAILED: ${failed.map((result) => result.target).join(", ")}\n`);
process.exit(failed.length === 0 ? 0 : 1);
