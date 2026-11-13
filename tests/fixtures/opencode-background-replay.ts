import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, RawEvent, RuntimeEventBody, Session } from "../../packages/oar/src/contracts/session.js";
import { acpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

/** Replays of the recorded OpenCode 2.3.0 background child runs (experiments/opencode-child-background). */
const evidence = (name: string): string => fileURLToPath(new URL(`../../experiments/opencode-child-background/${name}`, import.meta.url));
const replayAgent = fileURLToPath(new URL("fake-acp-opencode-replay.mjs", import.meta.url));

export interface WireFrame { readonly atMs: number; readonly direction?: string; readonly message: JsonRecord }
export function wireOf(name: string): WireFrame[] {
  const text = readFileSync(evidence(name), "utf8");
  const recorded = asRecord(parseJson(text));
  assert.ok(Array.isArray(recorded?.wire));
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Recorded native evidence, read verbatim.
  return recorded.wire as WireFrame[];
}
/** The native runtime→client notifications, in recorded order. */
export function notificationsOf(name: string): { readonly method: string; readonly params: JsonRecord }[] {
  return wireOf(name).flatMap(({ direction, message }) => {
    const params = asRecord(message.params);
    return direction === undefined && typeof message.method === "string" && params !== null ? [{ method: message.method, params }] : [];
  });
}
export const frames = (log: readonly RawEvent[], sessionId: string): Frame[] => log.flatMap((entry) => entry.kind === "frame" && entry.sessionId === sessionId ? [entry] : []);
export const eventsOf = (log: readonly RawEvent[], sessionId: string): RuntimeEventBody[] => frames(log, sessionId).flatMap((entry) => entry.body.events);

export interface ReplayedRun {
  readonly session: Session;
  /** OAR's `initialize` params as the agent received them. */
  readonly clientCapabilities: () => JsonRecord | null;
  readonly cleanup: () => Promise<void>;
}

/** Replay a recorded run by name, or a wire derived from one (`wire`, written under `name` beside the capture). */
export async function replay(profile: AcpSessionProfile, name: string, wire?: readonly WireFrame[]): Promise<ReplayedRun> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oar-opencode-child-"));
  const capture = path.join(directory, "initialize.json");
  const source = wire === undefined ? evidence(name) : path.join(directory, name);
  if (wire !== undefined) { writeFileSync(source, JSON.stringify({ wire })); }
  const session = await acpSession({ ...profile, args: [replayAgent, source, capture] })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() },
  );
  return {
    session,
    clientCapabilities: (): JsonRecord | null => {
      const params = asRecord(parseJson(readFileSync(capture, "utf8")));
      return asRecord(params?.clientCapabilities);
    },
    cleanup: async (): Promise<void> => { await session.dispose(); rmSync(directory, { recursive: true, force: true }); },
  };
}
