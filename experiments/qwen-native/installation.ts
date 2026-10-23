/** Compare native installation queries in fresh homes, then repeat in each same home. No login or model request. */
/* oxlint-disable no-await-in-loop -- Serial runs distinguish cold extraction from the same home's warm startup. */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { locateExecutable } from "../../packages/oar/src/shared/installation.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/run.js";

const resolved = locateExecutable(process.env.OAR_QWEN_BIN ?? "qwen");
if (resolved === null) { throw new Error("Install Qwen or set OAR_QWEN_BIN"); }
const executable: string = resolved;
const inherited = Object.fromEntries(["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"]
  .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));

async function compare(flag: string, sample: number): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), "oar-qwen-installation-"));
    try {
      const env = { ...inherited, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, "config") };
      for (const phase of ["cold", "warm"]) {
        const started = performance.now();
        const result = await runExecutable(executable, [flag], { cwd: root, env });
        const elapsedMs = Math.round(performance.now() - started);
        const files = await readdir(root);
        process.stdout.write(`${JSON.stringify({ platform: process.platform, sample, flag, phase, elapsedMs,
          ok: result.ok, exitCode: result.exitCode, nativeFiles: files.includes(".qwen"),
          version: flag === "--version" ? result.stdout.trim() : undefined,
          stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
          timeoutMs: result.diagnostics?.timeoutMs })}\n`);
        if (!result.ok) { process.exitCode = 1; }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
}

for (let sample = 1; sample <= 3; sample += 1) {
  for (const flag of ["--version", "--help"]) { await compare(flag, sample); }
}
