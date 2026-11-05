/* oxlint-disable import/max-dependencies -- A real binary, a scripted provider, an MCP server and the process table meet in this test. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import type { ControlResult, Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import type { SessionCleanup } from "../../packages/oar/src/contracts/placement.js";
import { awaitTurnEnd, codexInstallation, codexSession, promptAndWait } from "../../packages/oar/src/index.js";
import { startCodexAimock, type AimockEnv } from "../harness/aimock.js";
import { expectAvailable } from "./support/asserts.js";
import { ECHO_SERVER } from "./support/echo-mcp.js";

/*
 * SessionOptions.endTurnProcessesOnAbort on the real binary with a scripted
 * provider. Native turn/interrupt ends a foreground command but leaves its
 * detached child, and leaves a command that already yielded in the same turn.
 * The option ends both and nothing older. Without it this pins what codex does
 * on its own, so an upgrade that changes it shows up here. POSIX only: the
 * fixture reads `ps` and detaches with setsid.
 */

const COMMAND_SCRIPT = `
const { spawn } = require("node:child_process");
const detached = process.argv[3];
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", detached], { detached: true, stdio: "ignore" }).unref();
console.log("command started");
setInterval(() => {}, 1000);
`;

interface Markers {
  readonly mcp: string;
  readonly earlier: string;
  readonly command: string;
  readonly detached: string;
}

/** The pids whose command line holds `marker`. */
function running(marker: string): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" }).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return match?.[2]?.includes(marker) === true ? [Number(match[1])] : [];
  });
}

function killAll(markers: Markers): void {
  for (const marker of [markers.mcp, markers.earlier, markers.command, markers.detached]) {
    for (const pid of running(marker)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Gone meanwhile. */ }
    }
  }
}

function scripted(markers: Markers, script: string) {
  const node = JSON.stringify(process.execPath);
  const command = `exec ${node} ${JSON.stringify(script)} ${markers.command} ${markers.detached}`;
  return (mock: AimockEnv["mock"]): void => {
    mock.on({ userMessage: /START_EARLIER/u, hasToolResult: false }, { toolCalls: [{ id: "call-earlier", name: "exec_command", arguments: JSON.stringify({ cmd: `exec ${node} -e 'setInterval(() => {}, 1000)' ${markers.earlier}`, yield_time_ms: 250 }) }] });
    mock.on({ userMessage: /START_EARLIER/u, hasToolResult: true }, { content: "earlier command left running" });
    mock.on({ userMessage: /START_FOREGROUND/u, hasToolResult: false }, { toolCalls: [{ id: "call-foreground", name: "exec_command", arguments: JSON.stringify({ cmd: command, yield_time_ms: 300_000 }) }] });
    mock.on({ userMessage: /START_FOREGROUND/u, hasToolResult: true }, { content: "too late" });
    // The command yields, then the turn stays open on a slow model reply.
    mock.on({ userMessage: /START_YIELDED/u, hasToolResult: false }, { toolCalls: [{ id: "call-yielded", name: "exec_command", arguments: JSON.stringify({ cmd: command, yield_time_ms: 250 }) }] });
    mock.on({ userMessage: /START_YIELDED/u, hasToolResult: true }, { content: "too late" }, { latency: 15_000 });
    mock.on({ userMessage: /NEXT_PROMPT/u }, { content: "still usable" });
  };
}

function markersFor(tag: string): Markers {
  const unique = randomUUID();
  return { mcp: `oar-mcp-${tag}-${unique}`, earlier: `oar-earlier-${tag}-${unique}`, command: `oar-command-${tag}-${unique}`, detached: `oar-detached-${tag}-${unique}` };
}

async function cleanupOf(session: Session, abort: ControlResult): Promise<SessionCleanup> {
  return vi.waitFor(() => {
    const record = session.records().find((candidate) => candidate.kind === "response" && candidate.requestId === abort.request.id && candidate.body.kind === "cleanup");
    if (record?.kind !== "response" || record.body.kind !== "cleanup") { throw new Error("no cleanup response yet"); }
    return record.body.result;
  }, { timeout: 15_000, interval: 50 });
}

interface Scenario {
  readonly options: Partial<SessionOptions>;
  readonly markers: Markers;
  readonly turn: "START_FOREGROUND" | "START_YIELDED";
  /** Start a background command in an earlier turn, and let the MCP server be seen first. */
  readonly earlier: boolean;
  readonly after: (session: Session, abort: ControlResult) => Promise<void>;
}

/** Open, start the older work, abort a turn with the command running, then check the session still answers. */
async function abortedTurn({ options, markers, turn, earlier, after }: Scenario): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-codex-abort-"));
  const script = path.join(directory, "command.cjs");
  await writeFile(script, COMMAND_SCRIPT);
  const provider = await startCodexAimock(scripted(markers, script));
  const installation = await codexInstallation();
  expectAvailable(installation, "codex");
  let session: Session | undefined = undefined;
  try {
    session = await codexSession(installation, {
      cwd: process.cwd(), env: { ...provider.env },
      mcpServers: [{ name: "probe", command: process.execPath, args: [ECHO_SERVER, markers.mcp] }],
      ...options,
    });
    if (earlier) {
      expect(await promptAndWait(session, "START_EARLIER")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      expect(running(markers.earlier)).toHaveLength(1);
    }
    const requestsBefore = provider.mock.getRequests().length;
    const prompt = await session.prompt(turn);
    expect(prompt.response.body.kind).toBe("accepted");
    await vi.waitFor(() => {
      expect(running(markers.command).length).toBeGreaterThan(0);
      expect(running(markers.detached).length).toBeGreaterThan(0);
      // A yielded command has reported back: the model is now answering its result.
      if (turn === "START_YIELDED") { expect(provider.mock.getRequests().length).toBeGreaterThanOrEqual(requestsBefore + 2); }
    }, { timeout: 60_000, interval: 100 });
    const ended = awaitTurnEnd(session, prompt.request.seq);
    const abort = await session.abort();
    expect(abort.response.body.kind).toBe("accepted");
    expect(await ended).toMatchObject({ kind: "aborted" });
    await after(session, abort);

    // The app-server is untouched and answers the next prompt.
    expect(session.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(false);
    expect(await promptAndWait(session, "NEXT_PROMPT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    expect(running(markers.mcp)).toHaveLength(1);
  } finally {
    await session?.dispose();
    killAll(markers);
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectTurnProcessesEnded(session: Session, abort: ControlResult, markers: Markers): Promise<void> {
  const cleanup = await cleanupOf(session, abort);
  expect(cleanup.kind).toBe("completed");
  expect(cleanup.kind === "completed" ? cleanup.signalled : 0).toBeGreaterThan(0);
  await vi.waitFor(() => {
    expect(running(markers.command)).toEqual([]);
    expect(running(markers.detached)).toEqual([]);
  }, { timeout: 5000, interval: 50 });
  expect(running(markers.mcp)).toHaveLength(1);
}

describe.skipIf(process.env.OAR_TEST !== "codex-aimock" || process.platform === "win32")("Codex endTurnProcessesOnAbort", () => {
  test("ends a foreground command and its detached child, and keeps the MCP server and an earlier background command", async () => {
    const markers = markersFor("foreground");
    await abortedTurn({
      options: { endTurnProcessesOnAbort: true }, markers, turn: "START_FOREGROUND", earlier: true,
      after: async (session, abort) => {
        await expectTurnProcessesEnded(session, abort, markers);
        expect(running(markers.earlier)).toHaveLength(1);
      },
    });
  }, 180_000);

  test("ends a command the aborted turn left running after it yielded", async () => {
    const markers = markersFor("yielded");
    await abortedTurn({
      options: { endTurnProcessesOnAbort: true }, markers, turn: "START_YIELDED", earlier: true,
      after: async (session, abort) => {
        await expectTurnProcessesEnded(session, abort, markers);
        expect(running(markers.earlier)).toHaveLength(1);
      },
    });
  }, 180_000);

  test("a first turn right after open keeps the MCP server: the baseline already holds it", async () => {
    const markers = markersFor("first");
    await abortedTurn({
      options: { endTurnProcessesOnAbort: true }, markers, turn: "START_FOREGROUND", earlier: false,
      after: async (session, abort) => { await expectTurnProcessesEnded(session, abort, markers); },
    });
  }, 180_000);

  test.each(["START_FOREGROUND", "START_YIELDED"] as const)("without the option an abort of %s records no cleanup and leaves what native leaves", async (turn) => {
    const markers = markersFor(`off-${turn}`);
    await abortedTurn({
      options: {}, markers, turn, earlier: true,
      after: async (session, abort) => {
        // Native teardown gets time to act; what is still here after it is why the option exists.
        await delay(1000);
        expect(running(markers.detached).length).toBeGreaterThan(0);
        if (turn === "START_YIELDED") { expect(running(markers.command).length).toBeGreaterThan(0); }
        expect(running(markers.mcp)).toHaveLength(1);
        expect(running(markers.earlier)).toHaveLength(1);
        expect(session.records().flatMap((record) => record.kind === "response" && record.requestId === abort.request.id ? [record.body.kind] : [])).toEqual(["accepted"]);
      },
    });
  }, 180_000);
});
