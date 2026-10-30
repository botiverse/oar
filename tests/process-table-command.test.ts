import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { processTableCommand } from "../packages/oar/src/shared/executable/process-table-command.js";
import { processTableFailure } from "../packages/oar/src/shared/executable/process-tree.js";

// Query failures never expose command arguments, output or native error text.
afterEach(() => { vi.restoreAllMocks(); });
test.each([
  ["process.stdout.write('private'); process.exit(7)", { reason: "command_failed", exitCode: 7 }],
  ["process.stdout.write('x'.repeat(17 * 1024 * 1024))", { reason: "read_failed", code: "ENOBUFS" }],
  ["setTimeout(() => {}, 60000)", { reason: "timeout", code: "ETIMEDOUT", timeoutMs: 5000 }],
] as const)("query failure is bounded and redacted: %s", async (source, expected) => {
  const rejected: unknown[] = [];
  const onRejected = (error: unknown): void => { rejected.push(error); };
  process.on("unhandledRejection", onRejected);
  try {
    const result = await processTableCommand(process.execPath, ["-e", source]).catch((error: unknown) => processTableFailure(error, "windows", 1));
    expect(result).toEqual({ ok: false, source: "windows", elapsedMs: 1, ...expected });
    await nextTurn();
    expect(rejected).toEqual([]);
  } finally { process.off("unhandledRejection", onRejected); }
});

test("query drains stdout and returns the complete successful output", async () => {
  expect(await processTableCommand(process.execPath, ["-e", "process.stdout.write('table')"])).toBe("table");
});

// oxlint-disable-next-line eslint/max-statements -- The query root exits but its child holds stdout; only the query deadline may release the caller.
test("query deadline includes pipes held after the query root exits", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "oar-query-pipe-"));
  const file = path.join(dir, "tool.pid");
  const source = `const {spawn} = require('node:child_process'); const fs = require('node:fs'); const tool = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: ['ignore', 1, 'ignore'], detached: true}); fs.writeFileSync(process.argv[1], String(tool.pid)); process.exit(0);`;
  let tool: number | undefined = undefined;
  try {
    const started = performance.now();
    const failure = await processTableCommand(process.execPath, ["-e", source, file]).catch((error: unknown) => processTableFailure(error, "ps", 1));
    tool = Number(await readFile(file, "utf8"));
    expect(failure).toEqual({ ok: false, source: "ps", elapsedMs: 1, reason: "timeout", code: "ETIMEDOUT", timeoutMs: 5000 });
    expect(performance.now() - started).toBeLessThan(10_000);
  } finally {
    if (tool === undefined) { try { tool = Number(await readFile(file, "utf8")); } catch { /* Not started. */ } }
    if (tool !== undefined) { try { process.kill(tool, "SIGKILL"); } catch { /* Already gone. */ } }
    await rm(dir, { recursive: true, force: true });
  }
});
