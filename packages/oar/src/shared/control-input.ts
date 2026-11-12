import { conversationOf } from "../observe/conversation.js";
import { findCarriedInput, invalidCarriedInput } from "../observe/input-carries.js";
import type { RawEvent, RequestBody, ResponseBody } from "../contracts/session.js";

/** Refuse an input with neither text nor images before contacting the runtime. Whitespace is left intact. */
export function emptyInputRefusal(body: RequestBody): ResponseBody | null {
  if ((body.kind === "prompt" || body.kind === "steer" || body.kind === "queue")
    && body.input === "" && (body.images?.length ?? 0) === 0) {
    return { kind: "rejected", code: "unsupported", reason: "empty input: give text or images" };
  }
  return null;
}

/**
 * Refuse text longer than `maxBytes` (UTF-8) before contacting a runtime that
 * would cut it without saying so: the caller keeps the whole input.
 */
export function inputBytesRefusal(maxBytes: number | undefined, input: string): ResponseBody | null {
  if (maxBytes === undefined) { return null; }
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes <= maxBytes) { return null; }
  return { kind: "rejected", code: "unsupported", failure: "input_too_large", reason: `input is ${String(bytes)} bytes, over OAR's ${String(maxBytes)}-byte bound for one input to this runtime, which cuts a longer one without saying so` };
}

/** Validate before publishing the attempt, while the original ownership is still visible. */
export function carriesRefusal(body: RequestBody, records: readonly RawEvent[], sessionId: string, agentPath: readonly string[]): ResponseBody | null {
  if (body.kind !== "prompt" || (body.carries?.length ?? 0) === 0) { return null; }
  const inputs = conversationOf(records).inputs;
  const invalid = invalidCarriedInput(body, (id) => findCarriedInput(inputs, { sessionId, agentPath }, id));
  return invalid === undefined ? null : { kind: "rejected", code: "unsupported", reason: `carries input ${invalid} is not a withdrawn or adapter-held input owned by this session and agent` };
}
