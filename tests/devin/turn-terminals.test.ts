/* oxlint-disable max-statements -- Each case drives one native abort sequence end to end. */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { devinAcpProfile } from "../../packages/oar/src/runtimes/devin/session.js";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/index.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const tempDirs: string[] = [];
const fakeDevinScript = fileURLToPath(new URL("../fixtures/fake-acp-devin.mjs", import.meta.url));
const startFakeDevin = acpSession({ ...devinAcpProfile, args: [fakeDevinScript, "acp"] });
const fakeExecutable = { kind: "available", via: "executable", command: process.execPath } as const;

type StartedDevinSession = Awaited<ReturnType<typeof startFakeDevin>>;

function scratchDir(prefix: string): string {
  const raw = mkdtempSync(path.join(tmpdir(), prefix));
  const dir = realpathSync(raw);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const answeredTerminals = (session: StartedDevinSession): number => session.records().filter((record) => record.kind === "response" && record.body.kind === "answered"
  && typeof asRecord(record.body.native)?.terminalId === "string").length;
const cleanupOf = (session: StartedDevinSession, requestId: string): unknown => session.records().find((record) => record.kind === "response" && record.requestId === requestId && record.body.kind === "cleanup");
const until = async (check: () => boolean): Promise<void> => { await vi.waitFor(() => { expect(check()).toBe(true); }, { timeout: 5000, interval: 20 }); };

test("devin with endTurnProcessesOnAbort ends the aborted turn's command and keeps the session usable", async () => {
  const dir = scratchDir("oar-devin-abort-");
  const marker = path.join(dir, "marker.txt");
  const session = await startFakeDevin(fakeExecutable, { cwd: dir, endTurnProcessesOnAbort: true });
  try {
    const started = await session.prompt(`terminal-hold ${marker} 800`);
    await until(() => answeredTerminals(session) === 1);
    const stop = await session.abort();
    expect(stop.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "aborted" });
    await until(() => cleanupOf(session, stop.requestId) !== undefined);
    expect(cleanupOf(session, stop.requestId)).toMatchObject({ body: { kind: "cleanup", result: { kind: "completed", signalled: 1 } } });
    await delay(1200);
    expect(existsSync(marker)).toBe(false);
    expect(await promptAndWait(session, "after the stop")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  } finally {
    await session.dispose();
  }
});

test("devin without endTurnProcessesOnAbort leaves the aborted turn's command running", async () => {
  const dir = scratchDir("oar-devin-abort-native-");
  const marker = path.join(dir, "marker.txt");
  const session = await startFakeDevin(fakeExecutable, { cwd: dir });
  try {
    const started = await session.prompt(`terminal-hold ${marker} 800`);
    await until(() => answeredTerminals(session) === 1);
    const stop = await session.abort();
    await awaitTurnEnd(session, started.seq);
    await delay(1500);
    expect(existsSync(marker)).toBe(true);
    expect(cleanupOf(session, stop.requestId)).toBeUndefined();
  } finally {
    await session.dispose();
  }
});
