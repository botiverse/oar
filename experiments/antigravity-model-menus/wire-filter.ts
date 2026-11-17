/** Drop malformed/unrequested frames before the SDK can log their raw contents. */
import type { AcpProcessOptions } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

type AnyMessage = Parameters<NonNullable<AcpProcessOptions["incoming"]>>[0];
interface Responses {
  readonly outgoing: (message: AnyMessage) => void;
  readonly incoming: (message: AnyMessage) => AnyMessage | undefined;
}
export function privateResponses(): Responses {
  const pending = new Set<number | string>();
  return {
    outgoing(message: AnyMessage): void {
      const record = asRecord(message);
      if (typeof record?.method === "string" && (typeof record.id === "string" || typeof record.id === "number")) { pending.add(record.id); }
    },
    incoming(message: AnyMessage): AnyMessage | undefined {
      const record = asRecord(message);
      if (record === null || "method" in record || (typeof record.id !== "string" && typeof record.id !== "number") || !pending.has(record.id)) { return undefined; }
      const error = asRecord(record.error);
      if (error !== null && typeof error.code === "number") {
        pending.delete(record.id);
        return { jsonrpc: "2.0", id: record.id, error: { code: error.code, message: "[native diagnostic redacted]" } };
      }
      if (!("result" in record)) { return undefined; }
      pending.delete(record.id);
      return { jsonrpc: "2.0", id: record.id, result: record.result };
    },
  };
}
