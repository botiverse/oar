import { conversationOf } from "../observe/conversation.js";
import { invalidCarriedInput } from "../observe/input-carries.js";
import type { RawEvent, RequestBody, ResponseBody } from "../contracts/session.js";

/** Refuse an input with neither text nor images before contacting the runtime. Whitespace is left intact. */
export function emptyInputRefusal(body: RequestBody): ResponseBody | null {
  if ((body.kind === "prompt" || body.kind === "steer" || body.kind === "queue")
    && body.input === "" && (body.images?.length ?? 0) === 0) {
    return { kind: "rejected", code: "unsupported", reason: "empty input: give text or images" };
  }
  return null;
}

/** Validate before publishing the attempt, while the original ownership is still visible. */
export function carriesRefusal(body: RequestBody, records: readonly RawEvent[], sessionId: string, agentPath: readonly string[]): ResponseBody | null {
  if (body.kind !== "prompt" || (body.carries?.length ?? 0) === 0) { return null; }
  const inputs = conversationOf(records).inputs;
  const invalid = invalidCarriedInput(body, (id) => inputs.get(JSON.stringify([sessionId, agentPath, id])));
  return invalid === undefined ? null : { kind: "rejected", code: "unsupported", reason: `carries input ${invalid} is not a withdrawn input owned by this session and agent` };
}
