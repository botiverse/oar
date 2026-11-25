import type { LineProcess } from "../executable/index.js";
import { asRecord, type JsonRecord } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";

/** Record a native app request and, where supported, the dialect's automatic response. */
export function streamJsonAppRequest(
  kernel: SessionKernel,
  child: Pick<LineProcess, "write">,
  id: string,
  type: string,
  message: JsonRecord,
  appRequestResponse?: (type: string, requestId: string, request: JsonRecord) => JsonRecord | null,
): void {
  kernel.request("toApp", { kind: "native", type, native: message }, { id });
  const request = asRecord(message.request);
  const reply = typeof message.request_id === "string" && request !== null
    ? appRequestResponse?.(type, message.request_id, request)
    : undefined;
  if (reply !== undefined && reply !== null) {
    child.write(`${JSON.stringify(reply)}\n`);
    kernel.respond(id, { kind: "answered", native: reply });
  }
}
