/* oxlint-disable unicorn/no-useless-undefined -- A dropped incoming frame is an explicit undefined projection. */
/* oxlint-disable import/prefer-default-export -- Private transport boundary shared by every pooled ACP vendor. */
import { methods, type AnyMessage, type JsonRpcId } from "@agentclientprotocol/sdk";
import { asRecord } from "../json.js";
import type { AcpRouting } from "./routing.js";

/** Preserve native arrival order/phase and keep SDK connection diagnostics behind pool redaction. */
export function sharedAcpWire<T>(routing: AcpRouting<T>, extensions: readonly string[]): {
  outgoing(message: AnyMessage): void;
  incoming(message: AnyMessage): AnyMessage | undefined;
} {
  const requests = new Map<JsonRpcId, { readonly method: string; readonly sessionId: string | null }>();
  const notifications = new Set([methods.client.session.update, ...extensions]);
  return {
    outgoing(message) {
      if (!("id" in message)) {
        if ("method" in message && message.method === methods.protocol.cancelRequest) {
          const id = asRecord(message.params)?.requestId;
          if (typeof id === "string" || typeof id === "number" || id === null) { requests.delete(id); }
        }
        return;
      }
      if ("method" in message) {
        const params = asRecord(message.params);
        requests.set(message.id, { method: message.method, sessionId: typeof params?.sessionId === "string" ? params.sessionId : null });
      } else { routing.answered(message.id); }
    },
    incoming(message) {
      if (asRecord(message) === null || (!("id" in message) && !("method" in message))) {
        routing.diagnostic("invalid_message", message); return undefined;
      }
      if (!("method" in message)) {
        const request = requests.get(message.id);
        requests.delete(message.id);
        if (request === undefined) { routing.diagnostic("unknown_response", message); return undefined; }
        if ("result" in message) {
          const result = asRecord(message.result);
          const id = request.method === methods.agent.session.new ? result?.sessionId : request.sessionId;
          if (typeof id === "string" && [methods.agent.session.new, methods.agent.session.resume, methods.agent.session.load].some(method => method === request.method)) { routing.opened(id); }
        }
        return routing.redactValue(message);
      }
      if (!("id" in message) && !notifications.has(message.method)) {
        // Protocol cancellation must still reach the SDK's pending request controller.
        if (message.method === methods.protocol.cancelRequest) { return message; }
        routing.diagnostic(message.method, message.params); return undefined;
      }
      // Host requests must keep executable arguments/environment intact. Their
      // records use pool redaction; SDK schema failures become protocol errors.
      const requestId = "id" in message ? message.id : undefined;
      const projected = "id" in message ? message : routing.redactValue(message);
      const params = asRecord(projected.params);
      if (params !== null) { routing.ingress(params, requestId); }
      return projected;
    },
  };
}
