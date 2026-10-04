import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";

const exitModule = path.join(import.meta.dirname, "../packages/cli/src/exit.ts");

/** Run a script in a fresh process: its exit code, or null when it was still running after 10 s. */
function exitCodeOf(script: string): number | null {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { exitWhenFinished } from ${JSON.stringify(exitModule)};\n${script}`], { timeout: 10_000 });
  return result.status;
}

test("a finished command exits with its code although a runtime left a ref'd timer behind", () => {
  // The handle @cursor/sdk 1.0.35 leaves after it moved a shell call to the background: a 24 hour timer.
  expect(exitCodeOf("setTimeout(() => {}, 86_400_000);\nprocess.exitCode = 3;\nexitWhenFinished(50);")).toBe(3);
});

test("a process with nothing left still exits on its own", () => {
  expect(exitCodeOf("process.exitCode = 4;\nexitWhenFinished(60_000);")).toBe(4);
});
