import { asRecord, type JsonRecord } from "./json.js";

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
 * Which stored records oar's credential-redaction rules can change, and the
 * rules' version (docs/spec/record-stream.md). `version` goes up whenever a
 * rule is added or broadened, so a host that cleans stored records with
 * `redactRecord` rescans only when it changes. `frameTypePrefixes`: a frame
 * whose `body.type` starts with none of these is never changed, so a host
 * can pre-filter its storage by them.
 */
export const REDACTION_RULES: { readonly version: number; readonly frameTypePrefixes: readonly string[] } = {
  version: 1,
  // grok's MCP notifications (0.32.1).
  frameTypePrefixes: ["_x.ai/mcp/", "_x.ai/mcp_initialized"],
};

/** Whether a frame `type` is one the redaction rules cover. */
export function redactionCovers(type: string): boolean {
  return REDACTION_RULES.frameTypePrefixes.some((prefix) => type.startsWith(prefix));
}

/**
 * Grok 1.0.46's servers_updated reports the user's stdio env verbatim.
 * The other registered MCP notifications currently carry status/counters,
 * but apply the same credential rule if they include these fields. Do not
 * edit free-form text, other field names, other notifications or the received object.
 */
export function redactGrokNotification(method: string, params: JsonRecord): JsonRecord {
  return redactionCovers(method) ? redactMcpFields(params) : params;
}
