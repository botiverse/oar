/* oxlint-disable promise/avoid-new -- Bridge child-process events and the sampler shutdown timer. */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import path from "node:path";
import { codexPhaseRecord } from "../../sea-trial/harness/codex-phases.js";

const group = process.env.OAR_CODEX_WORKERS ?? "default";
if (!["default", "2", "1"].includes(group)) { throw new Error("worker group must be default, 2 or 1"); }
if (process.env.OAR_TEST !== "codex-aimock") { throw new Error("this experiment only runs codex-aimock"); }
const directory = path.resolve(process.env.OAR_CODEX_PHASES ?? "oar-trial-run/codex-comparison");
process.env.OAR_CODEX_PHASES = directory;
mkdirSync(directory, { recursive: true });
const source = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
writeFileSync(path.join(directory, "environment.json"), JSON.stringify({
  at: new Date().toISOString(), group, replica: process.env.OAR_CODEX_REPLICA ?? "local",
  platform: process.platform, arch: process.arch, node: process.version, versions: process.versions,
  availableParallelism: availableParallelism(), totalMemoryBytes: totalmem(),
  imageOS: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  sha: process.env.GITHUB_SHA ?? null, lockSha256: source("pnpm-lock.yaml"),
  baseConfigSha256: source("vitest.config.ts"), ciWorkflowSha256: source(".github/workflows/ci.yml"),
  coldStartTestSha256: source("sea-trial/vendor/codex.vendor.test.ts"),
}, null, 2), { flag: "wx" });
const selected = process.argv.slice(2);
const args = ["node_modules/vitest/vitest.mjs", "run", ...(selected.length === 0 ? ["sea-trial/vendor"] : selected),
  "--config", "experiments/windows-codex-ci/vitest.config.ts", ...(group === "default" ? [] : ["--maxWorkers", group])];
codexPhaseRecord("vitest_launch", { group });
const child = spawn(process.execPath, args, { stdio: "inherit" });
codexPhaseRecord("vitest_launched", { childPid: child.pid ?? null });
const result = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
  child.once("error", () => { codexPhaseRecord("vitest_spawn_error"); resolve({ code: 1, signal: null }); });
  child.once("exit", (code, signal) => { resolve({ code, signal }); });
});

// Launch sampling after Vitest, without delaying its global setup or warming CIM.
const stopFile = path.join(directory, "sampler.stop");
const log = openSync(path.join(directory, "sampler.log"), "a");
const sampler = process.platform === "win32" ? spawn("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
  "experiments/windows-codex-ci/resources.ps1", "-OutputFile", path.join(directory, "resources.jsonl"), "-StopFile", stopFile],
{ stdio: ["ignore", log, log] }) : null;
closeSync(log);
const samplingEnded = sampler === null ? Promise.resolve() : new Promise<void>((resolve) => {
  sampler.once("error", () => { codexPhaseRecord("sampler_spawn_error"); resolve(); });
  sampler.once("exit", (code, signal) => { codexPhaseRecord("sampler_exit", { code, signal }); resolve(); });
});
if (sampler === null) { codexPhaseRecord("sampler_not_windows"); }
const outcome = await result;
codexPhaseRecord("vitest_exit", outcome);
writeFileSync(stopFile, "stop\n");
const timeout = Promise.withResolvers<void>();
const timer = setTimeout(() => {
  codexPhaseRecord("sampler_stop_unreturned");
  sampler?.kill();
  timeout.resolve();
}, 10_000);
await Promise.race([samplingEnded, timeout.promise]);
clearTimeout(timer);
process.exit(outcome.code ?? 1);
