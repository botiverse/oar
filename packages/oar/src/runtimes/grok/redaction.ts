import { asRecord, type JsonRecord } from "../../shared/json.js";

/** Keep credential names and the native array/map shape, never their values. */
function redactNamedValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => {
      const record = asRecord(entry);
      return record !== null && Object.hasOwn(record, "value") ? { ...record, value: "[redacted]" } : entry;
    });
  }
  const record = asRecord(value);
  return record === null ? value : Object.fromEntries(Object.keys(record).map((key) => [key, "[redacted]"]));
}

function redactMcpFields(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => {
    if (key === "env" || key === "headers") {
      return [key, redactNamedValues(value)];
    }
    if (key === "bearer_token" || key === "bearerToken") {
      return [key, value === null ? null : "[redacted]"];
    }
    if (key === "mcpServers" && Array.isArray(value)) {
      return [key, value.map((entry: unknown) => {
        const server = asRecord(entry);
        return server === null ? entry : redactMcpFields(server);
      })];
    }
    return [key, value];
  }));
}

/**
 * Grok 1.0.46's servers_updated reports the user's stdio env verbatim.
 * The other registered MCP notifications currently carry status/counters,
 * but apply the same credential rule if they include these fields. Do not
 * edit free-form text, tool data, other notifications or the received object.
 */
export function redactGrokNotification(method: string, params: JsonRecord): JsonRecord {
  return method.startsWith("_x.ai/mcp/") || method === "_x.ai/mcp_initialized"
    ? redactMcpFields(params)
    : params;
}
