import type { ToolOutputPart } from "../contracts/tool-output.js";

/**
 * The text of a tool result for a host that shows only text: its text parts
 * joined by newlines, or undefined when it has none (an image, a block OAR
 * does not recognize). Render `content` itself to show images.
 */
export function toolResultText(content: readonly ToolOutputPart[] | undefined): string | undefined {
  const texts = (content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []));
  return texts.length === 0 ? undefined : texts.join("\n");
}
