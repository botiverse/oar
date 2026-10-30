/* oxlint-disable import/max-dependencies -- Common real-process fixture and lifecycle cleanup for shared ACP regressions. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { closeAcpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/profile.js";
import { sharedAcpSession, type AcpSharedOptions } from "../../packages/oar/src/shared/acp/shared-session.js";
import type { AcpUnattributed } from "../../packages/oar/src/shared/acp/routing.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const sessions: Session[] = [];
const directories: string[] = [];
const fixturePath = fileURLToPath(new URL("fake-acp-shared.mjs", import.meta.url));
const installation = { kind: "available", via: "executable", command: process.execPath } as const;

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(async (session) => { await session.dispose(); }));
  await Promise.all(directories.splice(0).map(async (directory) => { await rm(directory, { recursive: true, force: true }); }));
});

export async function fixture(overrides: Partial<AcpSharedOptions> = {}, profile: Partial<AcpSessionProfile> = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "oar-acp-shared-")); directories.push(cwd);
  const diagnostics: AcpUnattributed[] = [];
  const open = sharedAcpSession({ args: [fixturePath], capabilities: { queue: { durable: false }, attribution: "nested" }, abortTimeoutMs: 40,
    extensionNotifications: ["fixture/lineage", "fixture/usage"], ...profile,
  }, { processCwd: () => cwd, cleanup: closeAcpSession, diagnostic: (entry) => { diagnostics.push(entry); }, pending: { waitMs: 100 },
    associations: (_method, params) => typeof params.sessionId === "string" && typeof params.child === "string" ? [{ parent: params.sessionId, child: params.child }] : [], ...overrides });
  return { cwd, diagnostics, open: async (name: string, options: Partial<SessionOptions> = {}, requested: "auto" | "shared" = "auto") => {
    const directory = path.join(cwd, name); await mkdir(directory, { recursive: true });
    const session = await open(installation, { cwd: directory, ...options }, { requested, placement: "shared" }); sessions.push(session); return session;
  } };
}

export function opening(session: Session, method = "session/new") {
  const frame = session.records().find(record => record.kind === "frame" && record.body.type === method);
  return frame?.kind === "frame" ? asRecord(frame.body.native) : null;
}
export function text(session: Session): string { return session.records().flatMap(record => record.kind === "frame" ? record.body.events.flatMap(event => event.kind === "text_delta" ? [event.text] : []) : []).join("|"); }
