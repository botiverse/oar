/**
 * Host memory with one cursor session open, in process vs subprocess, on the
 * real `@cursor/sdk` the workspace installs. Makes no model request: it only
 * opens a session (`Agent.create`), which succeeds without a key, and
 * disposes it. HOME is a fresh temporary directory, so the SDK's local
 * store (`~/.cursor/...`) is written there and no stored login is read.
 *
 * Run: pnpm tsx experiments/cursor-subprocess/measure.ts
 *
 * Each measurement is its own fresh Node process (`--expose-gc`), so one
 * mode's loaded SDK cannot count in the other's. In each it reads, after a
 * forced GC: before anything opens, then with the session open. In
 * subprocess mode it also reads the RSS of the host's direct children
 * (`ps`), which is where the SDK lives then. Then it opens sessions with
 * `envBase: "clean"` and minimal environments, to see what the real SDK
 * needs to open.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCursorRuntime, type CursorRuntime } from "../../packages/oar/src/index.js";

const bundled = { kind: "available", via: "bundled" } as const;
const MB = 1024 * 1024;

function memory(): { readonly rssMb: number; readonly heapUsedMb: number } {
  const gc: unknown = Reflect.get(globalThis, "gc");
  if (typeof gc === "function") { Reflect.apply(gc, globalThis, []); }
  const used = process.memoryUsage();
  return { rssMb: Math.round(used.rss / MB), heapUsedMb: Math.round(used.heapUsed / MB) };
}

/** RSS of this process's direct children, in MB (Linux and macOS `ps`). */
function childrenRssMb(): number {
  const listed = spawnSync("ps", ["-o", "rss=", "--ppid", String(process.pid)], { encoding: "utf8" });
  return Math.round(listed.stdout.split("\n").map(Number).filter((kb) => kb > 0).reduce((sum, kb) => sum + kb, 0) / 1024);
}

async function measure(mode: "in_process" | "subprocess"): Promise<void> {
  const runtime: CursorRuntime = mode === "subprocess"
    ? createCursorRuntime({ execution: "subprocess", sdkModule: import.meta.resolve("@cursor/sdk") })
    : createCursorRuntime({ sdk: async () => { const sdk = await import("@cursor/sdk"); return sdk; } });
  const cwd = mkdtempSync(path.join(tmpdir(), "oar-cursor-measure-"));
  const before = memory();
  const started = Date.now();
  const session = await runtime.session(bundled, { cwd });
  const openMs = Date.now() - started;
  await delay(1000);
  const open = memory();
  const children = childrenRssMb();
  await session.dispose();
  rmSync(cwd, { recursive: true, force: true });
  console.log(JSON.stringify({ mode, openMs, before, open, childrenRssMb: children, sessionId: session.id }));
}

async function cleanOpen(label: string, env: Readonly<Record<string, string>>): Promise<void> {
  const runtime = createCursorRuntime({ execution: "subprocess", sdkModule: import.meta.resolve("@cursor/sdk"), envBase: "clean" });
  const cwd = mkdtempSync(path.join(tmpdir(), "oar-cursor-measure-"));
  try {
    const session = await runtime.session(bundled, { cwd, env });
    await session.dispose();
    console.log(JSON.stringify({ clean: label, opened: true }));
  } catch (error) {
    console.log(JSON.stringify({ clean: label, opened: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const [role] = process.argv.slice(2);
if (role === "in_process" || role === "subprocess") {
  await measure(role);
} else if (role === "clean") {
  const home = process.env.HOME ?? "";
  // Not `{}`: without HOME, Node's os.homedir() falls back to the user's
  // passwd entry, and the SDK wrote its agent store under the real home
  // (observed 2026-11-11, Linux). Run it only on a throwaway account.
  await cleanOpen("HOME", { HOME: home });
  await cleanOpen("HOME+PATH", { HOME: home, PATH: process.env.PATH ?? "" });
} else {
  const home = mkdtempSync(path.join(tmpdir(), "oar-cursor-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CURSOR_API_KEY;
  for (const mode of ["in_process", "subprocess", "in_process", "subprocess", "clean"]) {
    const run = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", import.meta.filename, mode], { encoding: "utf8", env, timeout: 120_000 });
    process.stdout.write(run.stdout);
    if (run.status !== 0) { process.stdout.write(`${mode} exited ${String(run.status)}: ${run.stderr.slice(-2000)}\n`); }
  }
  rmSync(home, { recursive: true, force: true });
}
