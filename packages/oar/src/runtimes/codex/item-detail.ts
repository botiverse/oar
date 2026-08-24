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

export function codexItemOutput(item: JsonRecord): string | undefined {
  switch (item.type) {
    case "commandExecution": {
      const status = typeof item.exitCode === "number"
        ? `exit ${String(item.exitCode)}`
        : (typeof item.status === "string" ? item.status : undefined);
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
      return [status, output].filter((part) => part !== undefined && part.length > 0).join("\n")
        || undefined;
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
