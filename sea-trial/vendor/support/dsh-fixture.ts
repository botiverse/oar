import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { dshInstallation, dshRuntime, type AvailableInstallation, type RawEvent, type RuntimeEventBody, type Session, type SessionOptions } from "../../../packages/oar/src/index.js";
import { asRecord } from "../../../packages/oar/src/shared/json.js";
import { startDshAimock, type DshAimock, type DshAimockOptions } from "../../harness/dsh-aimock.js";
import { startDshProvider, type DshProvider, type ProviderRequest, type Reply } from "./dsh-provider.js";

export const dshEnabled = process.env.OAR_TEST === "dsh-aimock";
/** DSH's Windows tool is its own shell; these turns script POSIX commands. */
export const posix = process.platform !== "win32";

export interface DshFixture {
  readonly provider: DshProvider;
  readonly aimock: DshAimock;
  readonly installation: AvailableInstallation;
  readonly open: (options?: Partial<SessionOptions>) => Promise<Session>;
}

/** Real DSH against a scripted loopback provider, in a home of its own. */
export async function withDshFixture(script: (request: ProviderRequest) => Reply, body: (fixture: DshFixture) => Promise<void>, overrides: Omit<DshAimockOptions, "providerUrl"> = {}): Promise<void> {
  const provider = await startDshProvider(script);
  const aimock = await startDshAimock({ ...overrides, providerUrl: provider.url });
  const sessions: Session[] = [];
  try {
    const installation = await dshInstallation();
    assert.ok(installation.kind === "available", `DSH is not installed: ${JSON.stringify(installation)}`);
    await body({ provider, aimock, installation, open: async (options = {}) => {
      const session = await dshRuntime.session(installation, { cwd: aimock.cwd, ...options, env: { ...aimock.env, ...options.env } });
      sessions.push(session);
      return session;
    } });
  } finally {
    await Promise.allSettled(sessions.map(async (session) => { await session.dispose(); }));
    await aimock.stop();
    await provider.stop();
  }
}

export const say = (text: string): Reply => ({ kind: "say", text });

export function eventsOf(records: readonly RawEvent[], sessionId?: string): readonly RuntimeEventBody[] {
  return records.flatMap((record) => record.kind === "frame" && (sessionId === undefined || record.sessionId === sessionId) ? record.body.events : []);
}

export async function untilEvent(session: Session, predicate: (event: RuntimeEventBody) => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = eventsOf(session.records());
    if (seen.some((event) => predicate(event))) { return; }
    assert.ok(Date.now() < deadline, `event not seen: ${JSON.stringify(seen.slice(-5))}`);
    // oxlint-disable-next-line no-await-in-loop -- Polling a stream the child writes.
    await delay(20);
  }
}

/** Wait for a count a background native step will reach; the caller asserts the count. */
export async function untilCount(count: () => number, wanted: number, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  // oxlint-disable-next-line no-await-in-loop -- Polling a stream the child writes.
  while (count() < wanted && Date.now() < deadline) { await delay(20); }
}

export function nativeOf(session: Session, type: string): readonly unknown[] {
  return session.records().flatMap((record) => record.kind === "frame" && record.body.type === type ? [record.body.native] : []);
}

/** RC has no native selection read: its model is unknown until a request says it. */
export function reportsSelection(session: Session): boolean {
  return asRecord(nativeOf(session, "dsh/opened")[0])?.modelCurrent === true;
}
