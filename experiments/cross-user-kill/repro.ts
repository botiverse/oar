/**
 * OAR's process-tree kill when the runtime runs as another OS user through a
 * `sudo -u` wrapper (installation.command): OAR's direct child is sudo
 * (setuid root, signalable by the host), everything below it is the worker's
 * (EPERM). Three cases, each with a stand-in runtime that leaves a background
 * process holding its stdout (`sh -c 'sleep 900 & exec sleep 901'`):
 *
 * 1. a session process (spawnLineProcess, killTree) stopped with kill();
 * 2. a signal to one of the worker's processes, as the turn cleanup sends it
 *    (signalEntries): is an EPERM a failed cleanup?
 * 3. a one-shot command (runExecutable) that times out.
 *
 * Results: README.md here. Needs (CI cannot provide them) a worker user and
 * passwordless `sudo -n -u <worker>`. Run from the repository root as the
 * host user; run the same file on a checkout without the change to see the
 * old behavior:
 *
 *   pnpm tsx experiments/cross-user-kill/repro.ts <worker>
 *
 * Every process it starts is the worker's or sudo; the worker's are killed
 * at the end (`sudo -n -u <worker> kill -KILL -1`).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runExecutable } from "../../packages/oar/src/shared/executable/run.js";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/process.js";
import { observeProcessTableAsync } from "../../packages/oar/src/shared/executable/process-table-async.js";
import { signalEntries } from "../../packages/oar/src/shared/executable/process-tree.js";

const [worker] = process.argv.slice(2);
if (worker === undefined) {
  console.error("usage: repro.ts <worker user>");
  process.exit(2);
}
// A short grace keeps the run quick; the default is 10 s.
process.env.OAR_KILL_GRACE_MS = "1000";
const uid = Number(execFileSync("id", ["-u", worker], { encoding: "utf8" }).trim());
const bin = mkdtempSync(path.join(tmpdir(), "oar-cross-user-kill-"));
chmodSync(bin, 0o755);
const wrapper = path.join(bin, "as-worker");
writeFileSync(wrapper, `#!/bin/sh\nexec sudo -n -u ${worker} -- "$@"\n`, { mode: 0o755 });
const runtime = ["sh", "-c", "sleep 900 & exec sleep 901"];
const elapsed = (since: number): string => `${(performance.now() - since).toFixed(0)} ms`;

/** The worker's processes now: `pid:name(pgid, ppid)`. */
function workers(): string[] {
  const found: string[] = [];
  for (const name of readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry))) {
    try {
      if (new RegExp(`^Uid:\\s+${String(uid)}\\s`, "mu").test(readFileSync(`/proc/${name}/status`, "utf8"))) {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        found.push(`${name}:${stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))}(pgid ${fields[2] ?? "?"}, ppid ${fields[1] ?? "?"})`);
      }
    } catch { /* Gone meanwhile. */ }
  }
  return found;
}
const killWorkers = (): void => { try { execFileSync("sudo", ["-n", "-u", worker, "--", "kill", "-KILL", "-1"], { stdio: "ignore" }); } catch { /* None left. */ } };
const bounded = async <T>(work: Promise<T>, ms: number): Promise<T | string> => {
  const result = await Promise.race([work, delay(ms, `still pending after ${String(ms / 1000)} s`)]);
  return result;
};

async function sessionKill(): Promise<void> {
  console.log("\n== 1. a session process through the wrapper, stopped with kill()");
  const child = spawnLineProcess(wrapper, runtime, { killTree: true });
  let closed = false;
  child.stdout.once("close", () => { closed = true; });
  await delay(700);
  console.log(`   root (OAR's child) ${String(child.pid)}: sudo; the worker's: ${workers().join(", ")}`);
  const started = performance.now();
  child.kill();
  const code = await bounded(child.exited, 30_000);
  const { cleanup } = child.diagnostics();
  console.log(`   exited: ${String(code)} after ${elapsed(started)}; cleanup ${JSON.stringify({ status: cleanup?.status, heldPipes: cleanup?.heldPipes })}`);
  await delay(3000);
  console.log(`   3 s later: OAR's stdout closed: ${String(closed)}; the worker's left: ${workers().join(", ") || "none"}`);
}

async function foreignSignal(): Promise<void> {
  console.log("\n== 2. a signal to the worker's process, as the turn cleanup sends it (signalEntries)");
  const child = spawnLineProcess(wrapper, runtime, { killTree: true });
  await delay(700);
  const observed = await observeProcessTableAsync();
  if (!observed.ok || child.pid === undefined) { console.log(`   no process table: ${JSON.stringify(observed)}`); return; }
  const below = [...observed.table.values()].filter((entry) => entry.ppid === child.pid);
  console.log(`   signalEntries(the worker's ${below.map((entry) => entry.pid).join(", ")}, SIGTERM) -> ${JSON.stringify(signalEntries(below, observed.table, () => false, "SIGTERM"))}`);
  child.kill();
  await bounded(child.exited, 30_000);
}

async function commandTimeout(): Promise<void> {
  console.log("\n== 3. a one-shot command through the wrapper that times out (runExecutable, timeoutMs 1500)");
  const started = performance.now();
  const result = await bounded(runExecutable(wrapper, runtime, { timeoutMs: 1500 }), 20_000);
  console.log(`   after ${elapsed(started)}: ${typeof result === "string" ? result : JSON.stringify({ ok: result.ok, timeoutMs: result.diagnostics?.timeoutMs, heldPipes: result.diagnostics?.cleanup?.heldPipes })}`);
}

try {
  console.log(`host ${String(process.getuid?.())}, worker ${worker} (uid ${String(uid)}); grace ${process.env.OAR_KILL_GRACE_MS} ms`);
  await sessionKill();
  killWorkers();
  await foreignSignal();
  killWorkers();
  await commandTimeout();
} finally {
  killWorkers();
  await delay(300);
  console.log(`\nafter 'sudo -u ${worker} kill -KILL -1': the worker's left: ${workers().join(", ") || "none"}`);
  rmSync(bin, { recursive: true, force: true });
}
// A pipe a holder kept open would otherwise keep this script alive.
process.exit(0);
