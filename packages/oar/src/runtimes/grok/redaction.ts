import { asRecord, type JsonRecord } from "../../shared/json.js";

/** Keep credential names and the native array/map shape, never their values. */
function redactNamedValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => {
      const record = asRecord(entry);
      return record !== null && Object.hasOwn(record, "value") ? { ...redactMcpFields(record), value: "[redacted]" } : redactMcpTree(entry);
    });
  }
  const record = asRecord(value);
  return record === null ? value : Object.fromEntries(Object.keys(record).map((key) => [key, "[redacted]"]));
}

function redactMcpFields(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => {
    if (key === "env" || key === "headers" || key === "http_headers") {
      return [key, redactNamedValues(value)];
    }
    if (key === "bearer_token" || key === "bearerToken") {
      return [key, value === null ? null : "[redacted]"];
    }
    return [key, redactMcpTree(value)];
  }));
}

function redactMcpTree(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => redactMcpTree(entry));
  }
  const record = asRecord(value);
  return record === null ? value : redactMcpFields(record);
}

/**
 * Grok 1.0.46's servers_updated reports the user's stdio env verbatim.
 * The other registered MCP notifications currently carry status/counters,
 * but apply the same credential rule if they include these fields. Do not
 * edit free-form text, other field names, other notifications or the received object.
 */
export function redactGrokNotification(method: string, params: JsonRecord): JsonRecord {
  return method.startsWith("_x.ai/mcp/") || method === "_x.ai/mcp_initialized"
    ? redactMcpFields(params)
    : params;
}
