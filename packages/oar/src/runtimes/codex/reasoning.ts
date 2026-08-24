import type { ReasoningContent } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

function textParts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((part) => {
    const text = asRecord(part)?.text;
    return typeof text === "string" && text.length > 0 ? [text] : [];
  });
}

export function codexReasoningContent(item: JsonRecord | null): ReasoningContent | null {
  if (item?.type !== "reasoning") {
    return null;
  }
  const text = [...textParts(item.summary), ...textParts(item.content)].join("\n");
  if (text.length > 0) {
    return { kind: "text", text };
  }
  return typeof item.encrypted_content === "string"
    ? { kind: "redacted" }
    : { kind: "empty" };
}
