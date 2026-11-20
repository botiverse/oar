import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "../../packages/oar/src/contracts/session.js";

/** One observer per fixture data home. Times use the same clock as the native Windows log. */
export interface OpenLifetime {
  start: number;
  opened?: number;
  closing?: number;
  ended?: number;
}

export function observeLifetime(lifetime: OpenLifetime, session: Session): void {
  lifetime.opened = Date.now();
  session.rawEvents(entry => {
    if (entry.agentPath.length > 0) { return; }
    if (entry.kind === "request" && entry.direction === "toRuntime" && entry.body.kind === "dispose") {
      lifetime.closing ??= entry.receivedAt;
    } else if (entry.kind === "response" && entry.body.kind === "exited") {
      lifetime.ended ??= entry.receivedAt;
    }
  }, { sessionId: session.id, afterSeq: -1 });
}

/** Includes peers that were closing at the native error time but exited before OAR rejected the open. */
export function peersAt(others: readonly OpenLifetime[], time: number): { opening: number; open: number; closing: number } {
  const result = { opening: 0, open: 0, closing: 0 };
  for (const peer of others) {
    if (peer.start > time || (peer.ended !== undefined && peer.ended <= time)) { continue; }
    if (peer.closing !== undefined && peer.closing <= time) { result.closing++; }
    else if (peer.opened !== undefined && peer.opened <= time) { result.open++; }
    else { result.opening++; }
  }
  return result;
}

/** Directory entries at rejection, before awaiting log I/O. Do not open a database or a sidecar. */
export function databaseFiles(dataRoot: string): { path: string; observedAt: number; present: string[] | null } {
  const path = join(dataRoot, "opencode", "opencode.db");
  const observedAt = Date.now();
  try {
    const names = readdirSync(dirname(path));
    const present = ["opencode.db", "opencode.db-wal", "opencode.db-shm", "opencode.db-journal"].filter(name => names.includes(name));
    return { path, observedAt, present };
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return { path, observedAt, present: missing ? [] : null };
  }
}
