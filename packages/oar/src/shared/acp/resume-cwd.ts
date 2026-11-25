/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import { ResumeCwdError, type ResumeCwdReason } from "../../contracts/resume-cwd-error.js";
import { asRecord, asRecordList, type JsonRecord } from "../json.js";
import { sameDirectory } from "../same-directory.js";
import { type AcpProcess, methods, withAcpDeadline } from "./process.js";

/**
 * A resume is safe only after the saved cwd is positively confirmed. Absence
 * from session/list is not evidence of a missing id: agy omits sessions that
 * have not received a prompt, but resumes them in their original directory.
 * Listing failures retain their native error classification; no resume follows them.
 */
export async function refuseResumeElsewhere(
  process: AcpProcess, sessionId: string, cwd: string, timeoutMs: number, normalizeListedCwd?: (listedCwd: string) => string,
): Promise<void> {
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
      throw unknownResumeCwd(sessionId, cwd, "listing_unavailable");
    }
    const found = sessions.find((session) => session.sessionId === sessionId);
    if (found !== undefined) {
      if (typeof found.cwd !== "string" || found.cwd.length === 0) { throw unknownResumeCwd(sessionId, cwd, "cwd_unreported"); }
      if (!sameDirectory(normalizeListedCwd?.(found.cwd) ?? found.cwd, cwd)) {
        throw new ResumeCwdError(`session ${sessionId} lives in ${found.cwd} and this runtime resumes it only there; the resume names ${cwd}`, {
          sessionId, requestedCwd: cwd, reason: "other_cwd", savedCwd: found.cwd,
        });
      }
      return;
    }
    if (page.nextCursor !== undefined && page.nextCursor !== null && typeof page.nextCursor !== "string") { throw unknownResumeCwd(sessionId, cwd, "listing_unavailable"); }
    cursor = typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : null;
    if (cursor !== null) {
      if (visited.has(cursor)) { throw unknownResumeCwd(sessionId, cwd, "listing_unavailable"); }
      visited.add(cursor);
    }
  } while (cursor !== null);
  throw unknownResumeCwd(sessionId, cwd, "not_listed");
}

/** No filesystem or history inference can substitute for the native directory. */
export function unknownResumeCwd(sessionId: string, cwd: string, reason: Exclude<ResumeCwdReason, "other_cwd">): ResumeCwdError {
  return new ResumeCwdError(`cannot confirm the saved directory of session ${sessionId}; this runtime resumes in its saved directory, so open a new session instead`, {
    sessionId, requestedCwd: cwd, reason,
  });
}
