/* oxlint-disable import/max-dependencies -- Instrument the actual behavior suite without changing product sources. */
/* oxlint-disable import/no-namespace -- Import type-only module namespaces for the importOriginal wrappers. */
import type * as ChildProcesses from "node:child_process";
import path from "node:path";
import type * as TableCommand from "../../packages/oar/src/shared/executable/process-table-command.js";
import type * as TableAsync from "../../packages/oar/src/shared/executable/process-table-async.js";
import type * as Cleanup from "../../packages/oar/src/shared/executable/process-cleanup.js";
import type * as Shutdown from "../../packages/oar/src/shared/executable/process-shutdown.js";
import { expect, test, vi } from "vitest";
import { trialCases } from "../../sea-trial/cases/suite.js";
import { selectBackend } from "../../sea-trial/harness/backends.js";
import { runSuite } from "../../sea-trial/harness/runner.js";
import { runtimeUnderTest } from "../../sea-trial/harness/subject.js";
import { openTrace } from "../../sea-trial/harness/trace.js";
import { prepareWindowsProcessTable } from "../../sea-trial/windows-process-table.js";
import { directory, startRound, timing } from "./timing.js";

vi.mock("../../packages/oar/src/shared/executable/process-table-command.js", async importOriginal => {
  const actual = await importOriginal<typeof TableCommand>();
  const log = await import("./timing.js");
  return { ...actual, processTableCommand: async (...args: Parameters<typeof actual.processTableCommand>) => {
    const id = log.nextQuery(); log.timing("query_command_start", { query: id });
    try { const output = await actual.processTableCommand(args[0], log.timedCommand(args[0], args[1], id), args[2]); log.timing("query_command_end", { query: id, ok: true }); return output; }
    catch (error) { log.timing("query_command_end", { query: id, ok: false, code: error instanceof Error && "code" in error ? error.code : null }); throw error; }
  } };
});

vi.mock("../../packages/oar/src/shared/executable/process-table-async.js", async importOriginal => {
  const actual = await importOriginal<typeof TableAsync>();
  const log = await import("./timing.js");
  return { ...actual, observeProcessTableAsync: async (...args: Parameters<typeof actual.observeProcessTableAsync>) => {
    const id = log.nextRequest(); log.timing("read_enqueued", { read: id });
    const result = await actual.observeProcessTableAsync(...args);
    log.timing("read_returned", { read: id, ok: result.ok, queryMs: result.elapsedMs, ...(result.ok ? {} : { reason: result.reason }) });
    return result;
  } };
});

vi.mock("../../packages/oar/src/shared/executable/process-cleanup.js", async importOriginal => {
  const actual = await importOriginal<typeof Cleanup>();
  const log = await import("./timing.js");
  return { ...actual, processTreeCleanup: (...args: Parameters<typeof actual.processTreeCleanup>) => {
    const cleanup = actual.processTreeCleanup(...args); const [pid] = args;
    return { ...cleanup,
      async capture() { log.timing("capture_start", { pid }); try { await cleanup.capture(); } finally { log.timing("capture_end", { pid, diagnostic: cleanup.diagnostics() }); } },
      async force(stop: () => void) { log.timing("force_start", { pid }); try { await cleanup.force(stop); } finally { log.timing("force_end", { pid, diagnostic: cleanup.diagnostics() }); } },
      async finish() { log.timing("after_exit_start", { pid }); try { await cleanup.finish(); } finally { log.timing("after_exit_end", { pid, diagnostic: cleanup.diagnostics() }); } },
    };
  } };
});

vi.mock("../../packages/oar/src/shared/executable/process-shutdown.js", async importOriginal => {
  const actual = await importOriginal<typeof Shutdown>();
  const log = await import("./timing.js");
  return { ...actual, processShutdown: (...args: Parameters<typeof actual.processShutdown>) => {
    const [child] = args; const { pid } = child;
    log.timing("root_started", { pid, killTree: args[1].killTree, shutdown: args[1].shutdown ?? "signal" });
    child.once("exit", (code, signal) => { log.timing("root_exit", { pid, code, signal }); });
    child.once("close", (code, signal) => { log.timing("root_close", { pid, code, signal }); });
    if (child.stdin !== null) {
      // oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the original receiver unchanged.
      child.stdin.end = new Proxy(child.stdin.end, { apply(target, receiver: unknown, values: unknown[]) {
        log.timing("eof_requested", { pid });
        // oxlint-disable-next-line typescript/no-unsafe-return -- Forward every native Writable.end overload unchanged.
        return Reflect.apply(target, receiver, values);
      } });
    }
    const shutdown = actual.processShutdown(...args);
    return { ...shutdown, stop() { log.timing("stop_requested", { pid }); shutdown.stop(); } };
  } };
});

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof ChildProcesses>();
  const log = await import("./timing.js");
  return { ...actual, execFile: new Proxy(actual.execFile, { apply(target, receiver: unknown, values: unknown[]) {
    const isTaskkill = typeof values[0] === "string" && /(?:^|[/\\])taskkill(?:\.exe)?$/iu.test(values[0]);
    const argv: unknown = values[1];
    const index = Array.isArray(argv) ? argv.indexOf("/pid") : -1;
    const root = Array.isArray(argv) && index >= 0 ? Number(argv[index + 1]) : null;
    if (isTaskkill) { log.timing("taskkill_start", { pid: root }); }
    const child: unknown = Reflect.apply(target, receiver, values);
    if (!(child instanceof actual.ChildProcess)) { throw new Error("execFile returned no process"); }
    if (isTaskkill) {
      child.once("spawn", () => { log.timing("taskkill_spawned", { pid: root, helper: child.pid }); });
      child.once("exit", (code, signal) => { log.timing("taskkill_exit", { pid: root, helper: child.pid, code, signal }); });
      child.once("close", (code, signal) => { log.timing("taskkill_close", { pid: root, helper: child.pid, code, signal }); });
    }
    return child;
  } }) };
});

test.each([1, 2, 3])("native behavior timing round %i", async round => {
  startRound(round);
  const prepared = process.env.OAR_WINDOWS_TIMING_PREPARED === "true";
  timing("round_start", { prepared, platform: process.platform, node: process.version });
  if (round === 1 && prepared) { prepareWindowsProcessTable(path.join(directory, "preparation.jsonl")); }
  const backend = await selectBackend(process.env.OAR_TIMING_BACKEND ?? "claude-aimock");
  try {
    const installation = await backend.runtime.installation?.(); expect(installation?.kind).toBe("available");
    openTrace(`timing-${String(round)}`);
    const outcomes = await runSuite(trialCases, runtimeUnderTest(backend.runtime, backend.aimock?.env), backend.concurrency);
    timing("round_outcomes", { outcomes });
    expect(outcomes.filter(result => result.kind === "fail")).toEqual([]);
  } finally { await backend.aimock?.stop(); await backend.close?.(); timing("round_end"); }
}, 90_000);
