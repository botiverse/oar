import { appendCleanupFailure, cleanupFailureReason } from "../../shared/executable/process-cleanup.js";
/* oxlint-disable import/max-dependencies -- Native transport, controls, projection and credential boundary. */
import { randomUUID } from "node:crypto";
import type { StartSession } from "../../contracts/session.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { streamJsonSession } from "../../shared/stream-json/session.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { qoderControl, qoderInitializeTimeoutMs, rememberQoderSecrets } from "./control.js";
import { launchQoder, closeQoder } from "./launch.js";
import { initialQoderProjection, qoderProjectionProfile } from "./projection.js";
import { qoderStartupError, qoderTerminationReason } from "./protocol.js";
import { qoderPermissionResponse } from "./permission.js";
import { qoderNativeModelName } from "./list-models.js";

async function readSelectedModel(control: ReturnType<typeof qoderControl>, requested: string, fetchStrategy: "cache" | "live"): Promise<JsonRecord | undefined> {
  const catalog = await control.request({ subtype: "get_models", fetchStrategy }).catch((error: unknown) => {
    throw new Error(`Qoder could not read ${fetchStrategy} model catalog to confirm ${JSON.stringify(requested)}: ${String(error)}`, { cause: error });
  });
  const payload = asRecord(asRecord(catalog.response)?.response);
  return asRecordList(payload?.models).find((entry) => entry.value === requested);
}

async function confirmModel(control: ReturnType<typeof qoderControl>, requested: string, reported: string | null): Promise<void> {
  let selected = await readSelectedModel(control, requested, "cache");
  if (qoderNativeModelName(selected) === undefined) { selected = await readSelectedModel(control, requested, "live"); }
  if (selected === undefined) { throw new Error(`Qoder model catalog did not contain requested selector ${JSON.stringify(requested)}`); }
  const resolvedId = qoderNativeModelName(selected);
  if (resolvedId === undefined) { throw new Error(`Qoder model catalog did not provide a resolved name for ${JSON.stringify(requested)}; reported ${JSON.stringify(reported)}`); }
  if (resolvedId !== reported) {
    throw new Error(`Qoder did not confirm model ${JSON.stringify(requested)}; reported ${JSON.stringify(reported)}, catalog resolved ${JSON.stringify(resolvedId)}`);
  }
}

export const qoderSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") { throw new Error("Qoder requires its executable installation"); }
  const sessionId = options.resume ?? randomUUID();
  const child = await launchQoder(installation.command, sessionId, options, installation.version);
  const control = qoderControl(child, (value) => { rememberQoderSecrets(value, credentials.add); });
  let model: string | null = null;
  try {
    return await streamJsonSession(child, sessionId, credentials, {
      projection: qoderProjectionProfile, initial: initialQoderProjection(),
      capabilities: { queue: { durable: false }, attribution: "attributed", images: false },
      steer: true, cancelQueuedCapability: "interrupt_cancel_queued_v1",
      userMessage: (text, inputId) => `${JSON.stringify({ type: "user", priority: "next", uuid: inputId ?? randomUUID(), session_id: sessionId,
        message: { role: "user", content: [{ type: "text", text }] } })}\n`,
      consume: (message) => {
        if (message.type === "system" && message.subtype === "init" && typeof message.model === "string") { model = message.model; }
        return control.consume(message);
      },
      open: async (projection) => {
        await control.request({ subtype: "initialize" }, qoderInitializeTimeoutMs).catch((error: unknown) => { throw qoderStartupError(error, options.effort); });
        if (options.model !== undefined && model !== options.model) { await confirmModel(control, options.model, model); }
        const answer = await control.request({ subtype: "get_settings" }).catch((error: unknown) => {
          if (options.effort === undefined) { throw error; }
          throw new Error(`Qoder could not confirm effort ${JSON.stringify(options.effort)}: ${String(error)}`, { cause: error });
        });
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
      exited: control.end, disposing: control.end, exitReason: () => qoderTerminationReason(child),
      permissionResponse: qoderPermissionResponse,
      close: async (active) => { if (active) { child.kill(); await child.exited; } else { await closeQoder(child); } },
    });
  } catch (error) {
    control.end(); await closeQoder(child);
    throw appendCleanupFailure(error, cleanupFailureReason(child.diagnostics().cleanup));
  }
});
