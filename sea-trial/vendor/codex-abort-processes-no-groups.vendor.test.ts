/* oxlint-disable import/max-dependencies -- A real binary, a scripted provider, the process table and the trace meet in this test. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import type { ControlResult, Session } from "../../packages/oar/src/contracts/session.js";
import type { SessionCleanup } from "../../packages/oar/src/contracts/placement.js";
import { awaitTurnEnd, codexInstallation, codexSession, promptAndWait } from "../../packages/oar/src/index.js";
// oxlint-disable-next-line import/no-namespace -- Off Windows, stand in for its table source to exercise this control's own logic.
import * as tables from "../../packages/oar/src/shared/executable/process-table-async.js";
import { observeProcessTable } from "../../packages/oar/src/shared/executable/process-tree.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../harness/aimock.js";
import { openTrace, record } from "../harness/trace.js";
import { expectAvailable } from "./support/asserts.js";

/*
 * The Windows control for SessionOptions.endTurnProcessesOnAbort. Windows has no
 * process groups to tell a turn's commands from codex's helpers and an MCP
 * server's workers, so the option must end nothing and say so. This case does not
 * skip on Windows: it runs natively on that job and writes its diagnostics to the
 * run's trace.jsonl. Elsewhere the table source is stubbed, which exercises the
 * same adapter path and this test's own logic but says nothing about Windows.
 */

const COMMAND = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
child.unref();
writeFileSync(process.argv[2], JSON.stringify({ command: process.pid, detached: child.pid }));
setInterval(() => {}, 1000);
`;

const REASON = "Windows has no process groups to tell this turn's processes from codex's own helpers and an MCP server's workers";

/** Each pid's start identity in the table now, or null once that process is gone. */
function identities(pids: readonly number[]): readonly (string | null)[] {
  const observed = observeProcessTable();
  if (!observed.ok) { throw new Error(`no process table: ${observed.reason}`); }
  return pids.map((pid) => observed.table.get(pid)?.start ?? null);
}

async function reportedPids(file: string): Promise<readonly number[]> {
  const report = asRecord(parseJson(await readFile(file, "utf8")));
  if (typeof report?.command !== "number" || typeof report.detached !== "number") { throw new TypeError("no pids reported yet"); }
  return [report.command, report.detached];
}

async function cleanupOf(session: Session, abort: ControlResult): Promise<SessionCleanup> {
  return vi.waitFor(() => {
    const found = session.records().find((candidate) => candidate.kind === "response" && candidate.requestId === abort.request.id && candidate.body.kind === "cleanup");
    if (found?.kind !== "response" || found.body.kind !== "cleanup") { throw new Error("no cleanup response yet"); }
    return found.body.result;
  }, { timeout: 15_000, interval: 50 });
}

test.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex endTurnProcessesOnAbort without process groups ends nothing, records failed with the reason, and the next prompt still works", async () => {
  openTrace("codex-aimock-abort-processes-no-groups");
  const directory = await mkdtemp(path.join(tmpdir(), "oar-codex-abort-control-"));
  const script = path.join(directory, "command.cjs");
  const report = path.join(directory, "report.json");
  await writeFile(script, COMMAND);
  const provider = await startCodexAimock((mock) => {
    // The command yields, then the turn stays open on a slow model reply.
    mock.on({ userMessage: /START_YIELDED/u, hasToolResult: false }, { toolCalls: [{ id: "call-control", name: "exec_command", arguments: JSON.stringify({ cmd: `node "${script}" "${report}"`, yield_time_ms: 250 }) }] });
    mock.on({ userMessage: /START_YIELDED/u, hasToolResult: true }, { content: "too late" }, { latency: 15_000 });
    mock.on({ userMessage: /NEXT_PROMPT/u }, { content: "still usable" });
  });
  if (process.platform !== "win32") { vi.spyOn(tables, "processTableSource").mockReturnValue("windows"); }
  const signals = vi.spyOn(process, "kill");
  const installation = await codexInstallation();
  expectAvailable(installation, "codex");
  record({ kind: "no_groups_control", phase: "open", platform: process.platform, nativeWindows: process.platform === "win32", installation });
  let session: Session | undefined = undefined;
  const started: number[] = [];
  try {
    session = await codexSession(installation, { cwd: process.cwd(), env: { ...provider.env }, endTurnProcessesOnAbort: true });
    const requestsBefore = provider.mock.getRequests().length;
    const prompt = await session.prompt("START_YIELDED");
    expect(prompt.response.body.kind).toBe("accepted");
    const pids = await vi.waitFor(async () => {
      expect(provider.mock.getRequests().length).toBeGreaterThanOrEqual(requestsBefore + 2);
      return reportedPids(report);
    }, { timeout: 60_000, interval: 100 });
    started.push(...pids);
    const before = identities(pids);
    record({ kind: "no_groups_control", phase: "running", pids, identities: before });
    expect(before).not.toContain(null);
    const ended = awaitTurnEnd(session, prompt.request.seq);
    const abort = await session.abort();
    record({ kind: "no_groups_control", phase: "aborted", response: abort.response.body });
    expect(abort.response.body.kind).toBe("accepted");
    expect(await ended).toMatchObject({ kind: "aborted" });
    const cleanup = await cleanupOf(session, abort);
    record({ kind: "no_groups_control", phase: "cleanup", cleanup });
    expect(cleanup).toEqual({ kind: "failed", reason: REASON });
    // Give anything wrongly signalled time to go, then compare identities.
    await delay(1000);
    const after = identities(pids);
    const sent = signals.mock.calls.map((call) => call[0]);
    record({ kind: "no_groups_control", phase: "after", identities: after, signalsSentByHost: sent });
    expect(sent).toEqual([]);
    expect(after).toEqual(before);
    expect(session.records().some((candidate) => candidate.kind === "response" && candidate.body.kind === "exited")).toBe(false);
    const next = await promptAndWait(session, "NEXT_PROMPT");
    record({ kind: "no_groups_control", phase: "next_prompt", next });
    expect(next).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    expect(identities(pids)).toEqual(before);
  } finally {
    vi.restoreAllMocks();
    await session?.dispose();
    for (const pid of started) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Gone meanwhile. */ }
    }
    await provider.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 180_000);
