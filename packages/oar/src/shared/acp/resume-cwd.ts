/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import { realpathSync } from "node:fs";
import path from "node:path";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { asRecord, asRecordList, type JsonRecord } from "../json.js";
import { type AcpProcess, methods, withAcpDeadline } from "./process.js";

function real(dir: string, paths: typeof path): string {
  try {
    return realpathSync(dir);
  } catch {
    return paths.resolve(dir);
  }
}

/** The same directory, spelled or linked differently. */
export function sameDirectory(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  // agy 1.5.0 reports Windows session/list cwd as /D:/path. Only remove
  // that URI-style drive prefix on Windows; POSIX paths remain literal.
  const normalize = (dir: string): string => platform === "win32" && /^\/[A-Za-z]:\//u.test(dir) ? dir.slice(1) : dir;
  const a = normalize(left);
  const b = normalize(right);
  return paths.resolve(a) === paths.resolve(b) || real(a, paths) === real(b, paths);
}

/**
 * A resume is safe only after the saved cwd is positively confirmed. Absence
 * from session/list is not evidence of a missing id: agy omits sessions that
 * have not received a prompt, but resumes them in their original directory.
 * Listing failures retain their native error classification; no resume follows them.
 */
export async function refuseResumeElsewhere(process: AcpProcess, sessionId: string, cwd: string, timeoutMs: number): Promise<void> {
  const method = methods.agent.session.list;
  let cursor: string | null = null;
  const visited = new Set<string>();
  do {
    const params: JsonRecord = cursor === null ? {} : { cursor };
    // oxlint-disable-next-line no-await-in-loop -- pages are sequential by construction.
    const page = asRecord(await withAcpDeadline(process, method, timeoutMs, (requestOptions) => process.connection.agent.request(method, params, requestOptions)));
    const sessions = asRecordList(page?.sessions);
    if (!Array.isArray(page?.sessions) || sessions.length !== page.sessions.length
      || sessions.some((session) => typeof session.sessionId !== "string" || session.sessionId.length === 0)) {
      throw unknownResumeCwd(sessionId);
    }
    const found = sessions.find((session) => session.sessionId === sessionId);
    if (found !== undefined) {
      if (typeof found.cwd !== "string" || found.cwd.length === 0) { throw unknownResumeCwd(sessionId); }
      if (!sameDirectory(found.cwd, cwd)) {
        throw new UnsupportedOptionError("cwd", `session ${sessionId} lives in ${found.cwd} and this runtime resumes it only there; the resume names ${cwd}`);
      }
      return;
    }
    if (page.nextCursor !== undefined && page.nextCursor !== null && typeof page.nextCursor !== "string") { throw unknownResumeCwd(sessionId); }
    cursor = typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : null;
    if (cursor !== null) {
      if (visited.has(cursor)) { throw unknownResumeCwd(sessionId); }
      visited.add(cursor);
    }
  } while (cursor !== null);
  throw unknownResumeCwd(sessionId);
}

/** No filesystem or history inference can substitute for the native directory. */
export function unknownResumeCwd(sessionId: string): UnsupportedOptionError {
  return new UnsupportedOptionError("cwd", `cannot confirm the saved directory of session ${sessionId}; this runtime resumes in its saved directory, so open a new session instead`);
}
