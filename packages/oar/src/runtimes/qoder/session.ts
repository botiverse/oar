import { randomUUID } from "node:crypto";
import type { StartSession } from "../../contracts/session.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { streamJsonSession } from "../../shared/stream-json/session.js";
import { asRecord } from "../../shared/json.js";
import { qoderControl, rememberQoderSecrets } from "./control.js";
import { launchQoder, closeQoder } from "./launch.js";
import { initialQoderProjection, qoderProjectionProfile } from "./projection.js";

export const qoderSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") { throw new Error("Qoder requires its executable installation"); }
  const sessionId = options.resume ?? randomUUID();
  const child = await launchQoder(installation.command, sessionId, options);
  const control = qoderControl(child, (value) => { rememberQoderSecrets(value, credentials.add); });
  let model: string | null = null;
  try {
    return await streamJsonSession(child, sessionId, credentials, {
      projection: qoderProjectionProfile, initial: initialQoderProjection(),
      capabilities: { queue: { durable: false }, attribution: "attributed", images: false },
      steer: false, cancelQueuedCapability: "interrupt_cancel_queued_v1",
      userMessage: (text, inputId) => `${JSON.stringify({ type: "user", uuid: inputId ?? randomUUID(), session_id: sessionId,
        message: { role: "user", content: [{ type: "text", text }] } })}\n`,
      consume: (message) => {
        if (message.type === "system" && message.subtype === "init" && typeof message.model === "string") { model = message.model; }
        return control.consume(message);
      },
      open: async (projection) => {
        await control.request({ subtype: "initialize" });
        if (options.model !== undefined && model !== options.model) {
          throw new Error(`Qoder did not confirm model ${JSON.stringify(options.model)}; reported ${JSON.stringify(model)}`);
        }
        const answer = await control.request({ subtype: "get_settings" });
        const applied = asRecord(asRecord(asRecord(answer.response)?.response)?.applied);
        const effort = typeof applied?.effort === "string" ? applied.effort : null;
        if (options.effort !== undefined && effort !== options.effort) { throw new Error(`Qoder did not confirm effort ${JSON.stringify(options.effort)}; reported ${JSON.stringify(effort)}`); }
        // Preserve the native reply envelope and applied readback, redacting all private configuration.
        const envelope = asRecord(answer.response);
        const payload = asRecord(envelope?.response);
        const redacted = Object.fromEntries(Object.keys(payload ?? {}).map((key) => [key, key === "applied" && effort !== null ? { effort } : "[redacted]"]));
        projection.report({ type: "control_response", native: { ...answer, response: { ...envelope, response: redacted } },
          events: effort === null ? [] : [{ kind: "effort", effort }] });
      },
      exited: control.end, disposing: control.end,
      permissionResponse: (requestId, request) => ({ type: "control_response", response: { subtype: "success", request_id: requestId,
        response: { behavior: "allow", ...(request.input === undefined ? {} : { updatedInput: request.input }) } } }),
      close: async (active) => { if (active) { child.kill(); await child.exited; } else { await closeQoder(child); } },
    });
  } catch (error) {
    control.end(); await closeQoder(child);
    if (options.effort !== undefined) { throw new Error(`Qoder could not confirm effort ${JSON.stringify(options.effort)}: ${String(error)}`, { cause: error }); }
    throw error;
  }
});
