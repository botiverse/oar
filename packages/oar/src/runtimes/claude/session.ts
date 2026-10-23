import { randomUUID } from "node:crypto";
import type { StartSession } from "../../contracts/session.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { streamJsonSession } from "../../shared/stream-json/session.js";
import { claudeOpenSettings } from "./open-settings.js";
import { claudeContextBreakdownReader } from "./context-breakdown.js";
import { launchClaude } from "./launch.js";
import { claudeProjectionProfile, claudeUsageBaselined, initialClaudeProjection, resumedClaudeProjection } from "./projection.js";

/** Claude owns launch flags, private account/settings readbacks and usage baselines. */
export const claudeSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") {
    throw new Error("The claude session adapter needs an executable installation");
  }
  const sessionId = options.resume ?? randomUUID();
  const child = await launchClaude(installation.command, sessionId, options);
  const readback = claudeOpenSettings(child);
  const contextBreakdown = claudeContextBreakdownReader(child);
  return streamJsonSession(child, sessionId, credentials, {
    projection: claudeProjectionProfile,
    initial: options.resume === undefined ? initialClaudeProjection : resumedClaudeProjection,
    capabilities: { queue: { durable: false }, attribution: "attributed", images: true },
    steer: true,
    cancelQueuedCapability: "interrupt_cancel_queued_v1",
    consume: (message) => readback.consume(message) || contextBreakdown.consume(message),
    open: async (projection) => {
      await readback.confirm(options);
      if (options.resume !== undefined) {
        projection.replace(claudeUsageBaselined(projection.current(), await readback.usageBaseline()));
      }
    },
    exited: (code) => { readback.exited(code); contextBreakdown.exited(); },
    disposing: () => { contextBreakdown.exited(); },
    contextBreakdown: contextBreakdown.read,
    // Preserve Claude's existing behavior: permissions are recorded, not answered.
  });
});
