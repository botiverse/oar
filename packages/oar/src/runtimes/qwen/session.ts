/* oxlint-disable import/max-dependencies -- Session assembly wires protocol, process lifetime and private readbacks. */
import { appendCleanupFailure, cleanupFailureReason } from "../../shared/executable/process-cleanup.js";
import { randomUUID } from "node:crypto";
import type { McpServer, RuntimeEventBody, StartSession } from "../../contracts/session.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { checkMcpServerNames, isHttpMcpServer } from "../../shared/mcp-servers.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { streamJsonSession } from "../../shared/stream-json/session.js";
import { closeQwen } from "./close.js";
import { launchQwen } from "./launch.js";
import { qwenControl, qwenPermissionResponse } from "./control.js";
import { initialQwenProjection, qwenProjectionProfile } from "./projection.js";

/** Qwen's initialize is the in-memory SDK configuration channel, not its persistent mcp add command. */
export function qwenMcpConfig(servers: readonly McpServer[]): JsonRecord {
  checkMcpServerNames(servers);
  return Object.fromEntries(servers.map((server) => [server.name, isHttpMcpServer(server)
    ? { httpUrl: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) }
    : { command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }) }]));
}

/** Only report the level the runtime says it applied; absent does not become a requested-value echo. */
export function qwenEffort(answer: JsonRecord, requested?: string): readonly RuntimeEventBody[] {
  const response = asRecord(asRecord(answer.response)?.response);
  const status = asRecord(response?.effort_status);
  if (requested !== undefined && (status?.effort !== requested || status.applied !== true || status.override !== null)) {
    throw new Error(`Qwen could not apply effort ${JSON.stringify(requested)}: ${JSON.stringify(status)}`);
  }
  return status?.applied === true && status.override === null && typeof status.effort === "string" ? [{ kind: "effort", effort: status.effort }] : [];
}

export const qwenSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") { throw new Error("The Qwen session adapter needs an executable installation"); }
  const sessionId = options.resume ?? randomUUID();
  const mcpServers = qwenMcpConfig(options.mcpServers ?? []);
  const child = await launchQwen(installation.command, sessionId, options);
  const control = qwenControl(child);
  try {
    return await streamJsonSession(child, sessionId, credentials, {
      projection: qwenProjectionProfile, initial: initialQwenProjection(options.resume !== undefined),
      capabilities: { queue: { durable: false }, attribution: "attributed", images: false },
      steer: false,
      userMessage: (text, inputId) => `${JSON.stringify({ type: "user", uuid: inputId ?? randomUUID(), session_id: sessionId, parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text }] } })}\n`,
      consume: (message) => control.consume(message),
      open: async (projection) => {
        // FIRST stdin frame must be initialize; a user frame first disables the control dispatcher.
        const answer = await control.request({ subtype: "initialize", mcpServers, ...(options.effort === undefined ? {} : { effort: options.effort }) }).catch((error: unknown) => {
          if (options.effort !== undefined) { throw new Error(`Qwen could not confirm effort ${JSON.stringify(options.effort)}: ${String(error)}`, { cause: error }); }
          throw error;
        });
        const native = asRecord(asRecord(answer.response)?.response);
        if (native?.session_id !== sessionId) { throw new Error(`Qwen initialized a different session: ${String(native?.session_id)}`); }
        const events = qwenEffort(answer, options.effort);
        projection.report({ type: "control_response", native: answer, events });
      },
      exited: () => { control.end(); }, disposing: () => { control.end(); },
      permissionResponse: qwenPermissionResponse,
      close: async (active) => { if (active) { child.kill(); await child.exited; } else { await closeQwen(child); } },
    });
  } catch (error) { await closeQwen(child); throw appendCleanupFailure(error, cleanupFailureReason(child.diagnostics().cleanup)); }
});
