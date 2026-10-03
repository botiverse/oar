/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import { realpathSync } from "node:fs";
import path from "node:path";
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

/** Refuse a resume that names another directory than the one `session/list` says the session lives in. */
export async function refuseResumeElsewhere(process: AcpProcess, sessionId: string, cwd: string, timeoutMs: number): Promise<void> {
  const method = methods.agent.session.list;
  let cursor: string | null = null;
  do {
    const params: JsonRecord = cursor === null ? {} : { cursor };
    // oxlint-disable-next-line no-await-in-loop -- pages are sequential by construction.
    const page = asRecord(await withAcpDeadline(process, method, timeoutMs, (requestOptions) => process.connection.agent.request(method, params, requestOptions)));
    const found = asRecordList(page?.sessions).find((session) => session.sessionId === sessionId);
    if (found !== undefined) {
      if (typeof found.cwd === "string" && !sameDirectory(found.cwd, cwd)) {
        throw new Error(`session ${sessionId} lives in ${found.cwd} and this runtime resumes it only there; the resume names ${cwd}`);
      }
      return;
    }
    cursor = typeof page?.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : null;
  } while (cursor !== null);
}
