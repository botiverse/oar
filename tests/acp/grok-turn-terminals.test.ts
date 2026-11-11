/* oxlint-disable max-statements, import/max-dependencies -- Each case drives one native terminal sequence end to end. */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { RawEvent, Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/index.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fixture, profile } from "../fixtures/acp-session-support.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); })); });

async function grok(endTurnProcessesOnAbort: boolean): Promise<{ readonly session: Session; readonly dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-grok-turn-terminals-"));
  directories.push(dir);
  const session = await acpSession({ ...grokAcpProfile, ...profile({ args: [fixture, "grok-native"] }) })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd(), ...(endTurnProcessesOnAbort ? { endTurnProcessesOnAbort } : {}) });
  return { session, dir };
}
const answeredTerminals = (records: readonly RawEvent[]): number => records.filter((record) => record.kind === "response" && record.body.kind === "answered"
  && typeof asRecord(record.body.native)?.terminalId === "string").length;
const cleanupOf = (records: readonly RawEvent[], requestId: string): unknown => records.find((record) => record.kind === "response" && record.requestId === requestId && record.body.kind === "cleanup");
const until = async (check: () => boolean): Promise<void> => { await vi.waitFor(() => { expect(check()).toBe(true); }, { timeout: 5000, interval: 20 }); };

test("an aborted Grok turn's terminal is stopped and reported; an earlier turn's keeps running and the session stays usable", async () => {
  const { session, dir } = await grok(true);
  const earlier = path.join(dir, "earlier");
  const aborted = path.join(dir, "aborted");
  try {
    expect(await promptAndWait(session, `terminal-done ${earlier} 1500`)).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const started = await session.prompt(`terminal-hold ${aborted} 1500`);
    await until(() => answeredTerminals(session.records()) === 2);
    const stop = await session.abort();
    expect(stop.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "aborted" });
    await until(() => cleanupOf(session.records(), stop.requestId) !== undefined);
    expect(cleanupOf(session.records(), stop.requestId)).toMatchObject({ body: { kind: "cleanup", result: { kind: "completed", signalled: 1 } } });
    await delay(2000);
    expect(existsSync(aborted)).toBe(false);
    expect(existsSync(earlier)).toBe(true);
    expect(await promptAndWait(session, "after the stop")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  } finally { await session.dispose(); }
});

test("without the option an abort leaves the turn's terminal running and records no cleanup", async () => {
  const { session, dir } = await grok(false);
  const marker = path.join(dir, "kept");
  try {
    const started = await session.prompt(`terminal-hold ${marker} 800`);
    await until(() => answeredTerminals(session.records()) === 1);
    const stop = await session.abort();
    await awaitTurnEnd(session, started.seq);
    await delay(1500);
    expect(existsSync(marker)).toBe(true);
    expect(cleanupOf(session.records(), stop.requestId)).toBeUndefined();
  } finally { await session.dispose(); }
});
