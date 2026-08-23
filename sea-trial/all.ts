// Run several backends CONCURRENTLY — each is its own process (backend env
// setup is process-scoped by design, so processes are the isolation unit).
// Full per-backend output goes to its own log file (no interleaving); stdout
// carries only each backend's summary lines.
// Usage: tsx sea-trial/all.ts [backend...]   (default: mock + the aimocks)
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const backends = process.argv.slice(2);
const targets = backends.length > 0 ? backends : ["mock", "claude-aimock", "codex-aimock", "pi-aimock"];
const logDir = process.env.OAR_TRACE_DIR ?? path.join(tmpdir(), "oar-sea-trial");
mkdirSync(logDir, { recursive: true });

const results = await Promise.all(targets.map(async (target) => {
  const logPath = path.join(logDir, `${target}-${new Date().toISOString().replaceAll(":", "-")}.log`);
  const log = createWriteStream(logPath);
  const result = await new Promise<{ target: string; code: number | null; summary: string[]; logPath: string }>((resolve) => {
    const child = spawn("pnpm", ["run", "sea-trial"], {
      env: { ...process.env, OAR_TEST: target },
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
        if (/^(?:FAIL |SKIPPED |trace: )|clean$|— skipping$/u.test(line)) {
          summary.push(line);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      log.write(chunk.toString());
    });
    child.on("exit", (code) => {
      log.end();
      resolve({ target, code, summary, logPath });
    });
  });
  return result;
}));

for (const result of results) {
  process.stdout.write(`── ${result.target} ${result.code === 0 ? "✓" : "✗"}\n`);
  for (const line of result.summary) {
    process.stdout.write(`   ${line}\n`);
  }
  process.stdout.write(`   log: ${result.logPath}\n`);
}
const failed = results.filter((result) => result.code !== 0);
process.stdout.write(failed.length === 0
  ? `all ${results.length} backends clean\n`
  : `FAILED: ${failed.map((result) => result.target).join(", ")}\n`);
process.exit(failed.length === 0 ? 0 : 1);
