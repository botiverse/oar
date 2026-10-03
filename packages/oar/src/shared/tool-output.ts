import type { ToolOutputPart } from "../contracts/tool-output.js";
import { asRecord } from "./json.js";

/**
 * One content block as a tool output part. Images come in two shapes:
 * Anthropic's `{type: "image", source: {type: "base64", media_type, data}}`
 * (claude's `Read` of an image) and the MCP / pi / ACP
 * `{type: "image", data, mimeType}`. Any block that is neither text nor a
 * recognized image is kept whole as `other`.
 */
export function toolOutputPart(block: unknown): ToolOutputPart {
  const record = asRecord(block);
  if (record?.type === "text" && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }
  if (record?.type === "image") {
    const source = asRecord(record.source);
    if (source?.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
      return { type: "image", mediaType: source.media_type, data: source.data };
    }
    if (typeof record.data === "string" && typeof record.mimeType === "string") {
      return { type: "image", mediaType: record.mimeType, data: record.data };
    }
  }
  return { type: "other", value: block };
}

/**
 * A tool result value as `tool_call_ended.content`: a string is one text
 * part, an array is its blocks in order (`unwrap` reaches a block a wrapper
 * carries, ACP's `{type: "content", content}`), anything else is one `other`
 * part, and an absent value or an empty array is no content.
 */
export function toolContent(value: unknown, unwrap: (block: unknown) => unknown = (block) => block): readonly ToolOutputPart[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : value.map((block) => toolOutputPart(unwrap(block)));
  }
  return [{ type: "other", value }];
}
