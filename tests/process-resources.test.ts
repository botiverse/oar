import { spawn } from "node:child_process";
import { once } from "node:events";
import type { readdir as Readdir, readFile as ReadFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { processTreeResources } from "../packages/oar/src/shared/executable/process-resources.js";

/*
 * The Linux reader's failure rules (process-resources.ts): a process gone
 * between the listing and its read is skipped; any other failure (EMFILE on a
 * low `ulimit -n`) fails the whole reading rather than giving a short count.
 * At most 64 stat files are open at once, and concurrent callers share one
 * read. `node:fs/promises` is wrapped so a test can fail one path and watch
 * how many reads are open.
 */

const fs = vi.hoisted(() => ({ fail: new Map<string, string>(), open: 0, peak: 0, listings: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<{ readonly readdir: typeof Readdir; readonly readFile: typeof ReadFile }>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      fs.listings += 1;
      return actual.readdir(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const file = typeof args[0] === "string" ? args[0] : "";
      const code = fs.fail.get(file);
      fs.open += 1;
      fs.peak = Math.max(fs.peak, fs.open);
      try {
        if (code !== undefined) {
          throw Object.assign(new Error(`${code}: ${file}`), { code });
        }
        return await actual.readFile(...args);
      } finally {
        fs.open -= 1;
      }
    },
  };
});

const linux = process.platform === "linux";
let child: ReturnType<typeof spawn> | null = null;

beforeEach(async () => {
  Object.assign(fs, { open: 0, peak: 0, listings: 0 });
  fs.fail.clear();
  // A runtime stand-in leading its own group, with one child in it.
  child = spawn(process.execPath, ["-e", String.raw`
    const kept = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    kept.once("spawn", () => { process.stdout.write(kept.pid + "\n"); });
    setTimeout(() => {}, 60000);
  `], { stdio: ["ignore", "pipe", "ignore"], detached: true });
});

afterEach(() => {
  if (child?.pid !== undefined) { process.kill(-child.pid, "SIGKILL"); }
});

async function tree(): Promise<{ readonly root: number; readonly kept: number }> {
  const reported: unknown[] = await once(child?.stdout ?? process.stdin, "data");
  return { root: child?.pid ?? 0, kept: Number(String(reported[0])) };
}

test.skipIf(!linux)("a process gone between the listing and its read is skipped", async () => {
  const { root, kept } = await tree();
  fs.fail.set(`/proc/${String(kept)}/stat`, "ENOENT");
  expect(await processTreeResources(root, "linux")).toMatchObject({ processes: 1 });
});

test.skipIf(!linux)("any other failure gives no reading, not a short count", async () => {
  const { root, kept } = await tree();
  fs.fail.set(`/proc/${String(kept)}/stat`, "EMFILE");
  expect(await processTreeResources(root, "linux")).toBeNull();
});

test.skipIf(!linux)("at most 64 stat files are open at once, and concurrent callers share one read", async () => {
  const { root } = await tree();
  const readings = await Promise.all(Array.from({ length: 5 }, async () => processTreeResources(root, "linux")));
  expect(readings.map((reading) => reading?.processes)).toEqual([2, 2, 2, 2, 2]);
  expect(fs.listings).toBe(1);
  expect(fs.peak).toBeGreaterThan(0);
  expect(fs.peak).toBeLessThanOrEqual(64);
  // The shared read is forgotten once it settles: a later call reads again.
  await processTreeResources(root, "linux");
  expect(fs.listings).toBe(2);
});
