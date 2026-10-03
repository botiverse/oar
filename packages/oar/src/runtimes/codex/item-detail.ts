import type { ToolOutputPart } from "../../contracts/tool-output.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { toolContent } from "../../shared/tool-output.js";

export function codexItemInput(item: JsonRecord): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return typeof item.command === "string" ? item.command : undefined;
    case "fileChange":
      return Array.isArray(item.changes) ? JSON.stringify(item.changes) : undefined;
    case "mcpToolCall":
      // The app-server schema defines arguments as a JSON value. Preserve that
      // value exactly instead of guessing a human-readable representation.
      return item.arguments === undefined ? undefined : JSON.stringify(item.arguments);
    case "webSearch":
      return typeof item.query === "string" ? item.query : undefined;
    case "sleep":
      return typeof item.durationMs === "number" ? JSON.stringify({ durationMs: item.durationMs }) : undefined;
    default:
      return undefined;
  }
}

/** The exit status of a `commandExecution` item; `null` is codex's own "no code" (a signal), absent means the item carries none (still running, declined). */
export function codexItemExitCode(item: JsonRecord): number | null | undefined {
  if (item.type !== "commandExecution" || !("exitCode" in item)) {
    return undefined;
  }
  return typeof item.exitCode === "number" ? item.exitCode : null;
}

/** A status word (`declined`, `completed`) when a command or file change reported nothing else. */
function statusOf(item: JsonRecord): string | undefined {
  return typeof item.status === "string" ? item.status : undefined;
}

/**
 * An `mcpToolCall` result (`{content, structuredContent?, _meta?}`, the
 * content being MCP blocks [src] app-server v2 `McpToolCallResult`): its
 * blocks, or the whole result when it has none; an error is its message.
 */
function mcpContent(item: JsonRecord): readonly ToolOutputPart[] | undefined {
  const error = asRecord(item.error);
  if (typeof error?.message === "string") {
    return [{ type: "text", text: `error: ${error.message}` }];
  }
  const result = asRecord(item.result);
  if (result === null) {
    return undefined;
  }
  return (Array.isArray(result.content) ? toolContent(result.content) : undefined) ?? [{ type: "other", value: result }];
}

/** A finished tool item's `tool_call_ended.content`. */
export function codexToolContent(item: JsonRecord): readonly ToolOutputPart[] | undefined {
  switch (item.type) {
    case "commandExecution": {
      // The exit status travels as `tool_call_ended.exitCode`; the content is the command's own output.
      const output = typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > 0 ? item.aggregatedOutput : undefined;
      return toolContent(output ?? statusOf(item));
    }
    case "fileChange":
      return toolContent(statusOf(item));
    case "mcpToolCall":
      return mcpContent(item);
    case "webSearch":
      return Array.isArray(item.results) ? [{ type: "other", value: item.results }] : undefined;
    default:
      return undefined;
  }
}
