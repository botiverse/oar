/* oxlint-disable import/max-dependencies -- Native processes, timers and a real HTTP connection verify event-loop responsiveness together. */
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/process.js";
import { processTableCommand } from "../packages/oar/src/shared/executable/process-table-command.js";
import { processTreeCleanup } from "../packages/oar/src/shared/executable/process-cleanup.js";
// oxlint-disable-next-line import/no-namespace -- Delay only table observations, retaining real native processes.
import * as tables from "../packages/oar/src/shared/executable/process-table-async.js";
import { gone } from "./fixtures/process-tree.js";

const rejected: unknown[] = [];
const onRejected = (error: unknown): void => { rejected.push(error); };
beforeEach(() => { rejected.length = 0; process.on("unhandledRejection", onRejected); });
afterEach(async () => {
  await delay(0);
  process.off("unhandledRejection", onRejected);
  vi.restoreAllMocks();
  expect(rejected).toEqual([]);
});
const echo = "console.log('ready'); process.stdin.on('data', chunk => process.stdout.write(chunk)); process.stdin.on('end', () => process.exit(0));";

// oxlint-disable-next-line eslint/max-statements -- One delayed native query must not freeze another runtime, timers or the host's HTTP connection.
test("stopping remains responsive and writes after kill are ignored before EOF", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-async-cleanup-"));
  const marker = path.join(dir, "release");
  const child = spawnLineProcess(process.execPath, ["-e", echo], { killTree: true, shutdown: "stdin" });
  const peer = spawnLineProcess(process.execPath, ["-e", echo]);
  const peerReady = Promise.withResolvers<void>(), peerReply = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
  const lines: string[] = [];
  child.onLine((line) => { lines.push(line); if (line === "ready") { ready.resolve(); } });
  peer.onLine((line) => { if (line === "ready") { peerReady.resolve(); } else if (line === "peer-output") { peerReply.resolve(); } });
  const server = createServer((_request, response) => { response.end("host-alive"); });
  const entered = Promise.withResolvers<void>();
  let queryComplete = false;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    await Promise.all([ready.promise, peerReady.promise]);
    const nativeRead = tables.observeProcessTableAsync;
    vi.spyOn(tables, "observeProcessTableAsync").mockImplementationOnce(async () => {
      entered.resolve();
      await processTableCommand(process.execPath, ["-e", "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); } }, 10);", marker]);
      queryComplete = true;
      return nativeRead();
    });
    child.kill(); child.write("forbidden-after-stop\n");
    await entered.promise;
    peer.write("peer-output\n");
    const address = server.address();
    expect(address !== null && typeof address !== "string").toBe(true);
    const port = address !== null && typeof address !== "string" ? address.port : 0;
    const [body] = await Promise.all([fetch(`http://127.0.0.1:${port}`).then(async (response) => response.text()), peerReply.promise, delay(10)]);
    expect(body).toBe("host-alive");
    expect(queryComplete).toBe(false);
    expect(child.stdin.writableEnded).toBe(false);
    await writeFile(marker, "go");
    expect(await child.exited).toBe(0);
    expect(lines).toEqual(["ready"]);
  } finally {
    await writeFile(marker, "go");
    vi.restoreAllMocks();
    child.kill(); peer.kill(); await Promise.all([child.exited, peer.exited]);
    const closed = once(server, "close"); server.closeAllConnections(); server.close(); await closed;
    await rm(dir, { recursive: true, force: true });
  }
});

// oxlint-disable-next-line eslint/max-statements -- Observe root exit before releasing revalidation, then require a single final exit and a dead tool.
test("final exit waits for asynchronous descendant cleanup and late listeners fire once", async () => {
  const child = spawnLineProcess(process.execPath, [fileURLToPath(new URL("fixtures/async-cleanup-tree.mjs", import.meta.url))], { killTree: true, shutdown: "stdin" });
  const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
  child.onLine((line) => { if (/^\d+$/u.test(line)) { ready.resolve(Number(line)); } });
  const exits: (number | null)[] = [];
  child.onExit((code) => { exits.push(code); });
  let tool: number | undefined = undefined;
  try {
    tool = await ready.promise;
    expect(await gone(tool, 50)).toBe(false);
    const nativeRead = tables.observeProcessTableAsync;
    vi.spyOn(tables, "observeProcessTableAsync").mockImplementationOnce(nativeRead).mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; return nativeRead();
    });
    child.kill(); await entered.promise;
    expect(child.diagnostics().exitCode).toBe(0);
    expect(exits).toEqual([]);
    expect(await gone(tool, 50)).toBe(false);
    release.resolve();
    expect(await child.exited).toBe(0);
    expect(await gone(tool)).toBe(true);
    expect(exits).toEqual([0]);
    child.onExit((code) => { exits.push(code); });
    await delay(0);
    expect(exits).toEqual([0, 0]);
    child.kill();
  } finally {
    release.resolve(); vi.restoreAllMocks(); child.kill(); await child.exited;
    if (tool !== undefined) { try { process.kill(tool, "SIGKILL"); } catch { /* Already gone. */ } }
  }
});

// oxlint-disable-next-line eslint/max-statements -- Resolve a reused-PID snapshot only after the owned root exits.
test("a root that exits during capture cannot claim a reused PID or retry its identity", async () => {
  let alive = true;
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof tables.observeProcessTableAsync>>>();
  const read = vi.spyOn(tables, "observeProcessTableAsync").mockReturnValue(gate.promise);
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  const cleanup = processTreeCleanup(123, () => alive);
  const capture = cleanup.capture();
  alive = false;
  gate.resolve({ ok: true, source: "windows", elapsedMs: 1, skipped: 0, table: new Map([[123, { pid: 123, ppid: process.pid, pgid: 0, start: "reused" }]]) });
  await capture; await cleanup.finish();
  expect(read).toHaveBeenCalledOnce();
  expect(signal).not.toHaveBeenCalled();
  expect(cleanup.diagnostics()).toEqual({ status: "unverified", observations: [{ ok: false, phase: "before_eof", source: "windows", elapsedMs: 1, reason: "missing_root" }] });
});

// oxlint-disable-next-line eslint/max-statements -- Each failure phase must settle and preserve diagnostics.
test.each(["capture", "force", "finish"])("rejected %s observation becomes cleanup diagnostics without an unhandled rejection", async (phase) => {
  const entries = [{ pid: process.pid, ppid: process.ppid, pgid: 0, start: "host" }, { pid: 123, ppid: process.pid, pgid: 0, start: "root" }, { pid: 456, ppid: 123, pgid: 0, start: "tool" }];
  const read = vi.spyOn(tables, "observeProcessTableAsync").mockResolvedValue({ ok: true, source: "windows", elapsedMs: 1, skipped: 0, table: new Map(entries.map((entry) => [entry.pid, entry])) });
  const cleanup = processTreeCleanup(123);
  if (phase !== "capture") { await cleanup.capture(); }
  read.mockRejectedValue(new Error("private observation failure"));
  if (phase === "capture") { await cleanup.capture(); }
  else if (phase === "force") { const stopRoot = vi.fn<() => void>(); await cleanup.force(stopRoot); expect(stopRoot).toHaveBeenCalledOnce(); }
  await cleanup.finish();
  expect(cleanup.diagnostics().status).toBe("unverified");
  expect(JSON.stringify(cleanup.diagnostics())).not.toContain("private");
});
