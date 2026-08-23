// Run several backends CONCURRENTLY — each is its own process (backend env
// setup is process-scoped by design, so processes are the isolation unit).
// Usage: tsx sea-trial/all.ts [backend...]   (default: mock + the aimocks)
import { spawn } from "node:child_process";

const backends = process.argv.slice(2);
const targets = backends.length > 0 ? backends : ["mock", "claude-aimock", "codex-aimock", "pi-aimock"];
const results = await Promise.all(targets.map(async (target) => {
  const result = await new Promise<{ target: string; code: number | null }>((resolve) => {
    const child = spawn("pnpm", ["run", "sea-trial"], {
      env: { ...process.env, OAR_TEST: target },
      stdio: ["ignore", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) {
          process.stdout.write(`[${target}] ${line}\n`);
        }
      }
    });
    child.on("exit", (code) => {
      resolve({ target, code });
    });
  });
  return result;
}));
const failed = results.filter((result) => result.code !== 0);
process.stdout.write(failed.length === 0
  ? `all ${results.length} backends clean\n`
  : `FAILED: ${failed.map((result) => result.target).join(", ")}\n`);
process.exit(failed.length === 0 ? 0 : 1);
