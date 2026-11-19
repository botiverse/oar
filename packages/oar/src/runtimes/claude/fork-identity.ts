import { asRecord, type JsonRecord } from "../../shared/json.js";

/*
 * A resumed or forked session's identity read back from claude itself.
 * `--resume=<id>` must open `id` (never another session matched by `--name`
 * title), and `--fork-session --session-id=<new>` must run the copy under the
 * id OAR assigned, so the open confirms `Session.id` before returning. Claude
 * names its session in no answer at open but `get_status` ([env] 2.1.323:
 * `sections[].rows[]` with `{ label: "Session ID", value }` in the `Session`
 * section; the same answer carries the account email and organization, so it
 * stays private like the other readbacks). The first turn's `system/init` then
 * repeats it as `session_id`.
 */

/** The `get_status` control request for `requestId`, as a stdin line. */
export function claudeStatusRequest(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_status" } })}\n`;
}

/** The session id a `get_status` control response reports, or null when it names none. */
export function claudeStatusSessionId(answer: JsonRecord): string | null {
  const status = asRecord(asRecord(answer.response)?.response);
  const sections: unknown[] = Array.isArray(status?.sections) ? status.sections : [];
  for (const section of sections) {
    const listed = asRecord(section)?.rows;
    const rows: unknown[] = Array.isArray(listed) ? listed : [];
    for (const row of rows) {
      const record = asRecord(row);
      if (record?.label === "Session ID" && typeof record.value === "string" && record.value.length > 0) { return record.value; }
    }
  }
  return null;
}

/** Why the session cannot open as `expected`: claude's own report differs, or it gave none. Null when it confirms. */
export function claudeForkIdRefusal(expected: string, answer: JsonRecord | Error, kind: "resume" | "fork" = "fork"): string | null {
  const subject = kind === "fork" ? `the fork's session id ${expected}` : `resume ${expected}`;
  if (answer instanceof Error) { return `${answer.message}, so ${subject} cannot be confirmed`; }
  // A claude without get_status answers with an error response: the open fails closed (Session.id would be unconfirmed).
  const response = asRecord(answer.response);
  if (response?.subtype === "error") {
    const said = typeof response.error === "string" && response.error.length > 0 ? `: ${response.error}` : "";
    return `claude refused get_status${said}, so ${subject} cannot be confirmed`;
  }
  const reported = claudeStatusSessionId(answer);
  if (reported === expected) { return null; }
  if (reported === null) { return `claude get_status reported no session id, so ${subject} cannot be confirmed`; }
  return kind === "fork"
    ? `claude runs the fork as session ${reported}, not ${expected} as OAR assigned`
    : `claude opened session ${reported}, not ${expected} as requested`;
}
