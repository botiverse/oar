import type { SessionKernel } from "../../shared/session-kernel.js";
import type { JsonRecord } from "../../shared/json.js";
import type { AppServerClient } from "./app-server-client.js";

const declined = "OAR has no way to answer this request";

/**
 * Each decision request's own "no", from the app-server schema. `Session` has
 * no way for a host to answer, so a request left open would only hang the turn.
 */
const nativeRefusals: Readonly<Record<string, JsonRecord>> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/permissions/requestApproval": { permissions: {} },
  "item/tool/requestUserInput": { answers: {} },
  "item/tool/call": { contentItems: [{ type: "inputText", text: declined }], success: false },
  "mcpServer/elicitation/request": { action: "decline" },
  applyPatchApproval: { decision: "denied" },
  execCommandApproval: { decision: "denied" },
};

/** The reply to a request codex sent: its native refusal, or `method not found` for anything that is not a decision. */
export function codexRequestReply(method: string): { readonly result: JsonRecord } | { readonly error: { readonly code: number; readonly message: string } } {
  const result = nativeRefusals[method];
  return result === undefined ? { error: { code: -32_601, message: `${declined}: ${method}` } } : { result };
}

/** Record a request codex sent, verbatim, then answer it and record the answer. */
export function codexServerRequests(kernel: SessionKernel, client: AppServerClient) {
  return (id: string, method: string, params: JsonRecord): void => {
    kernel.request("toApp", { kind: "native", type: method, native: params }, { id });
    const reply = codexRequestReply(method);
    client.respond(id, reply);
    kernel.respond(id, { kind: "answered", native: reply });
  };
}
