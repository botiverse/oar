import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { privateTempDir, sweepPrivateTempDirs } from "../packages/oar/src/shared/private-temp.js";

// A file URL, not a path: ESM reads a Windows path's drive letter as a URL scheme.
const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "../packages/oar/src/shared/private-temp.ts")).href;

/** A prefix no other test or host uses. */
function freshPrefix(): string {
  return `oar-test-private-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}-`;
}

/** Run `script` in a fresh host process with `privateTempDir` imported; the last line it printed. */
function host(script: string): { readonly status: number | null; readonly signal: NodeJS.Signals | null; readonly printed: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { privateTempDir } from ${JSON.stringify(moduleUrl)};\n${script}`], { timeout: 20_000, encoding: "utf8" });
  return { status: result.status, signal: result.signal, printed: result.stdout.trim().split("\n").at(-1) ?? "" };
}

const makeOne = (prefix: string): string => `const directory = await privateTempDir(${JSON.stringify(prefix)}); console.log(directory.path);`;

test("a directory is 0700 and named for its host's pid; remove() takes it", async () => {
  const prefix = freshPrefix();
  const directory = await privateTempDir(prefix);
  expect(path.basename(directory.path).startsWith(`${prefix}${String(process.pid)}-`)).toBe(true);
  if (process.platform !== "win32") {
    expect(statSync(directory.path).mode & 0o777).toBe(0o700);
  }
  directory.remove();
  directory.remove();
  expect(existsSync(directory.path)).toBe(false);
});

test("a host that exits without removing its directory, by process.exit() or an uncaught exception, takes it on its exit event", () => {
  for (const ending of ["process.exit(0);", "throw new Error(\"host bug\");"]) {
    const prefix = freshPrefix();
    const { printed } = host(`${makeOne(prefix)}\n${ending}`);
    assert.ok(printed.includes(prefix), `the host printed ${JSON.stringify(printed)}`);
    expect(existsSync(printed)).toBe(false);
  }
});

/** The directory a host made before it was SIGKILLed: still there. */
function killedHostDirectory(prefix: string): string {
  const { signal, printed } = host(`${makeOne(prefix)}\nprocess.kill(process.pid, "SIGKILL");`);
  expect({ signal, left: existsSync(printed) }).toEqual({ signal: "SIGKILL", left: true });
  return printed;
}

test.skipIf(process.platform === "win32")("a SIGKILLed host leaves its directory to the next sweep, which keeps a running host's", async () => {
  const prefix = freshPrefix();
  const printed = killedHostDirectory(prefix);
  // A directory of a host that still runs (this test's parent).
  const running = path.join(tmpdir(), `${prefix}${String(process.ppid)}-alive`);
  mkdirSync(running);
  try {
    await sweepPrivateTempDirs(prefix);
    expect({ dead: existsSync(printed), running: existsSync(running) }).toEqual({ dead: false, running: true });
  } finally {
    rmSync(running, { recursive: true, force: true });
    rmSync(printed, { recursive: true, force: true });
  }
});

/** `cat` reading a FIFO in `directory`: it blocks in open() until a writer comes, which unlinking alone would never be. */
async function blockedReader(directory: string): Promise<{ readonly exited: Promise<unknown[]>; kill(): void }> {
  const fifo = path.join(directory, "pipe");
  expect(spawnSync("mkfifo", ["-m", "600", fifo]).status).toBe(0);
  const reader = spawn("cat", [fifo], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(reader, "exit");
  await delay(200);
  return {
    exited,
    kill: () => {
      reader.kill();
    },
  };
}

test.skipIf(process.platform === "win32")("removing a directory lets a reader blocked opening a FIFO in it go", async () => {
  const directory = await privateTempDir(freshPrefix());
  const reader = await blockedReader(directory.path);
  directory.remove();
  const outcome = await Promise.race([reader.exited, delay(5000, "still waiting")]);
  reader.kill();
  expect(outcome).toEqual([0, null]);
  expect(existsSync(directory.path)).toBe(false);
});
