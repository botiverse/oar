import { openClaudeModelRequests } from "./model-requests.js";
import { claudeCompaction, CLAUDE_COMPACTION_BUSY } from "./compaction.js";
import type { StartSession } from "../../contracts/session.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { streamJsonSession } from "../../shared/stream-json/session.js";
import { claudeOpenSettings } from "./open-settings.js";
import { closeLineProcess } from "../../shared/executable/close.js";
import { claudeContextBreakdownReader } from "./context-breakdown.js";
import { launchClaude } from "./launch.js";
import { claudeProjectionProfile, claudeUsageBaselined, initialClaudeProjection, resumedClaudeProjection } from "./projection.js";

/** Decline unattended MCP elicitations as Claude's Agent SDK does when no handler is set; leave other control requests unanswered. */
export function claudeAppRequestResponse(type: string, requestId: string): {
  readonly type: "control_response";
  readonly response: { readonly subtype: "success"; readonly request_id: string; readonly response: { readonly action: "decline" } };
} | null {
  return type === "elicitation"
    ? { type: "control_response", response: { subtype: "success", request_id: requestId, response: { action: "decline" } } }
    : null;
}

/** Claude owns launch flags, private account/settings readbacks and usage baselines. */
export const claudeSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") {
    throw new Error("The claude session adapter needs an executable installation");
  }
  // A fork (SessionOptions.fork) runs under a new id OAR assigns, like a new session.
  const sessionId = options.fork === undefined ? options.resume ?? globalThis.crypto.randomUUID() : globalThis.crypto.randomUUID();
  const requests = await openClaudeModelRequests(sessionId, options, installation.version);
  const child = await launchClaude(installation.command, sessionId, options, requests?.setting).catch((error: unknown) => { requests?.remove(); throw error; });
  if (requests !== undefined) { child.onExit(requests.remove); }
  const readback = claudeOpenSettings(child);
  const contextBreakdown = claudeContextBreakdownReader(child);
  const compaction = claudeCompaction(child);
  const session = await streamJsonSession(child, sessionId, credentials, {
    projection: claudeProjectionProfile,
    initial: options.resume === undefined ? initialClaudeProjection : resumedClaudeProjection,
    capabilities: { queue: { durable: false }, attribution: "attributed", images: true },
    steer: true,
    stopTask: (taskId) => ({ subtype: "stop_task", task_id: taskId }),
    compaction: { busyReason: CLAUDE_COMPACTION_BUSY, create: compaction.create },
    cancelQueuedCapability: "interrupt_cancel_queued_v1",
    consume: (message) => {
      requests?.observe(message);
      return readback.consume(message) || contextBreakdown.consume(message) || compaction.consume(message);
    },
    ...(requests === undefined ? {} : { lastModelRequest: requests.read }),
    open: async (projection) => {
      await readback.confirm(options, requests);
      // Both a plain resume (which Claude can otherwise resolve by --name title
      // to a different session's UUID) and a fork must run under sessionId.
      if (options.resume !== undefined) { await readback.confirmSessionId(sessionId, options); }
      if (options.resume !== undefined) {
        projection.replace(claudeUsageBaselined(projection.current(), await readback.usageBaseline()));
      }
    },
    exited: (code) => { readback.exited(code); contextBreakdown.exited(); compaction.close(); },
    disposing: () => { requests?.close(); contextBreakdown.exited(); compaction.close(); },
    contextBreakdown: contextBreakdown.read,
    close: async (active) => { if (active) { child.kill(); await child.exited; } else { await closeLineProcess(child); } },
    // Decline unattended MCP elicitations; keep permission and other control requests recorded-only.
    appRequestResponse: claudeAppRequestResponse,
  });
  if (requests !== undefined) {
    session.events((event) => { if (event.agentPath.length === 0 && event.kind === "turn_ended") { requests.ended(event.outcome); } });
  }
  return session;
});
