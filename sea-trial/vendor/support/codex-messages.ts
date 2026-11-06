import { asRecord, parseJson } from "../../../packages/oar/src/shared/json.js";

/** Keep the real Responses stream, optionally omit text deltas, and name the message's native phase. */
export function codexMessageReply(body: string, deltas: boolean, phase?: string): string {
  const message = (value: unknown): unknown => {
    const item = asRecord(value);
    return item?.type === "message" && phase !== undefined ? { ...item, phase } : value;
  };
  return body.split("\n\n").flatMap(block => {
    const data = block.split("\n").find(line => line.startsWith("data: "))?.slice(6);
    const event = data === undefined ? null : asRecord(parseJson(data));
    if (event === null) { return [block]; }
    if (!deltas && event.type === "response.output_text.delta") { return []; }
    const response = asRecord(event.response);
    const rewritten = {
      ...event,
      ...(event.item === undefined ? {} : { item: message(event.item) }),
      ...(Array.isArray(response?.output) ? { response: { ...response, output: response.output.map(message) } } : {}),
    };
    return [block.split("\n").map(line => line.startsWith("data: ") ? `data: ${JSON.stringify(rewritten)}` : line).join("\n")];
  }).join("\n\n");
}
