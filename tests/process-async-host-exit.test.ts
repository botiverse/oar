import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import asyncCleanupHost from "./fixtures/async-cleanup-host.js";
import { expect, test } from "vitest";
import { gone, reportedProcess, type ProcessIdentity, signalFixture } from "./fixtures/process-tree.js";

// Root and pipe closure must not discard captured descendants while asynchronous cleanup is pending.
// oxlint-disable-next-line eslint/max-statements -- One subprocess host and every PID it owns are checked and reclaimed together.
test.each(["capture", "finish"])("host exit reclaims pending %s cleanup and its query", async (phase) => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-async-host-"));
  const file = (name: string): string => path.join(dir, name);
  const pids: ProcessIdentity[] = [];
  try {
    const host = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", asyncCleanupHost], {
      encoding: "utf8", timeout: 40_000,
      env: { ...process.env, OAR_TREE_PIDS: file("pids.json"), OAR_CLEANUP_PHASE: phase, OAR_UNHANDLED: file("unhandled"), OAR_PAUSED: file("paused"), OAR_QUERY_PID: file("query") },
    });
    const parsed: unknown = JSON.parse(readFileSync(file("pids.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("root" in parsed) || !("tool" in parsed)) { throw new Error("Missing tree identities"); }
    pids.push(reportedProcess(parsed.root), reportedProcess(parsed.tool));
    const query = file("query");
    if (existsSync(query)) { const value: unknown = JSON.parse(readFileSync(query, "utf8")); pids.push(reportedProcess(value)); }
    expect(host.error, host.stderr).toBeUndefined();
    expect(host.status, host.stderr).toBe(23);
    expect(readFileSync(file("paused"), "utf8")).toBe(phase);
    expect(existsSync(file("unhandled"))).toBe(false);
    expect(await Promise.all(pids.map(async (pid) => gone(pid))), `surviving: ${JSON.stringify(pids)}; ${host.stderr}`).toEqual(pids.map(() => true));
  } finally {
    for (const pid of pids) { signalFixture(pid); }
    rmSync(dir, { recursive: true, force: true });
  }
}, 50_000);
