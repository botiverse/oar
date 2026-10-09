/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import { realpathSync } from "node:fs";
import path from "node:path";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { asRecord, asRecordList, type JsonRecord } from "../json.js";
import { type AcpProcess, methods, withAcpDeadline } from "./process.js";

function real(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The same directory, spelled or linked differently. */
function sameDirectory(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right) || real(left) === real(right);
}

/**
 * Refuse a different cwd with UnsupportedOptionError. Return true when found,
 * false only after a complete, well-formed list, null when absence is unknown.
 * Listing failures propagate unchanged; they never prove a session missing.
 */
export async function refuseResumeElsewhere(process: AcpProcess, sessionId: string, cwd: string, timeoutMs: number): Promise<boolean | null> {
  const method = methods.agent.session.list;
  let cursor: string | null = null;
  const visited = new Set<string>();
  let complete = true;
  do {
    const params: JsonRecord = cursor === null ? {} : { cursor };
    // oxlint-disable-next-line no-await-in-loop -- pages are sequential by construction.
    const page = asRecord(await withAcpDeadline(process, method, timeoutMs, (requestOptions) => process.connection.agent.request(method, params, requestOptions)));
    const sessions = asRecordList(page?.sessions);
    if (!Array.isArray(page?.sessions) || sessions.length !== page.sessions.length
      || sessions.some((session) => typeof session.sessionId !== "string" || session.sessionId.length === 0)) {
      complete = false;
    }
    const found = sessions.find((session) => session.sessionId === sessionId);
    if (found !== undefined) {
      if (typeof found.cwd === "string" && !sameDirectory(found.cwd, cwd)) {
        throw new UnsupportedOptionError("cwd", `session ${sessionId} lives in ${found.cwd} and this runtime resumes it only there; the resume names ${cwd}`);
      }
      return true;
    }
    if (page?.nextCursor !== undefined && page.nextCursor !== null && typeof page.nextCursor !== "string") { return null; }
    cursor = typeof page?.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : null;
    if (cursor !== null) {
      if (visited.has(cursor)) { return null; }
      visited.add(cursor);
    }
  } while (cursor !== null);
  return complete ? false : null;
}
