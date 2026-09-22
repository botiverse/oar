import { asRecord, type JsonRecord } from "../../shared/json.js";

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

export function codexItemOutput(item: JsonRecord): string | undefined {
  switch (item.type) {
    case "commandExecution": {
      // The exit status travels as `tool_call_ended.exitCode`; the output is the command's own.
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
      if (output !== undefined && output.length > 0) {
        return output;
      }
      return typeof item.status === "string" ? item.status : undefined;
    }
    case "fileChange":
      return typeof item.status === "string" ? item.status : undefined;
    case "mcpToolCall": {
      const error = asRecord(item.error);
      if (typeof error?.message === "string") {
        return `error: ${error.message}`;
      }
      // result is the schema's nullable MCP result object; null means there is
      // no result to display.
      return item.result === undefined || item.result === null
        ? undefined
        : JSON.stringify(item.result);
    }
    case "webSearch":
      return Array.isArray(item.results) ? JSON.stringify(item.results) : undefined;
    default:
      return undefined;
  }
}
