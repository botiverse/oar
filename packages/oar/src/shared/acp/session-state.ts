import type { SessionOptions } from "../../contracts/session.js";
import type { AcpClientHooks } from "./client-app.js";
import { createAcpConfigUpdates } from "./config-updates.js";
import { createAcpNativeTurnTracker, type AcpNativeTurnTracker } from "./native-turns.js";
import { createAcpOpening } from "./opening.js";
import { createUsageUpdateGate, type AcpSessionProfile } from "./profile.js";
import { createAcpRecorder } from "./records.js";
import { createAcpTerminalHost } from "./terminal.js";
import { createAcpTokenUsage } from "./token-usage.js";

/** Everything one ACP session records through, created before its process opens. */
export interface AcpSessionState {
  readonly terminalHost: ReturnType<typeof createAcpTerminalHost>;
  readonly usageGate: ReturnType<typeof createUsageUpdateGate>;
  readonly tokenUsage: ReturnType<typeof createAcpTokenUsage>;
  readonly opening: ReturnType<typeof createAcpOpening>;
  readonly configUpdates: ReturnType<typeof createAcpConfigUpdates>;
  readonly recorder: ReturnType<typeof createAcpRecorder>;
  readonly hooks: AcpClientHooks;
  readonly nativeTurns: AcpNativeTurnTracker | undefined;
}

export function createAcpSessionState(profile: AcpSessionProfile, options: SessionOptions, environment: NodeJS.ProcessEnv, associations?: Parameters<typeof createAcpRecorder>[3], agentPid?: () => number | undefined): AcpSessionState {
  const terminalHost = createAcpTerminalHost(options.cwd, environment, {
    shellCommand: profile.terminalShellCommand === true,
    ...(agentPid === undefined ? {} : { agentPid }),
  });
  // The recorder queues everything until the handshake reveals the session
  // id and the kernel can be bound (records.ts).
  const usageGate = createUsageUpdateGate();
  const nativeTurns = createAcpNativeTurnTracker(profile.nativeTurns);
  const tokenUsage = createAcpTokenUsage(profile, nativeTurns?.sentByOar);
  const opening = createAcpOpening();
  const configUpdates = createAcpConfigUpdates();
  const recorder = createAcpRecorder(usageGate, profile.attributeUpdate, tokenUsage, associations, profile.projectUpdate, profile.projectExtension, nativeTurns, profile);
  const hooks: AcpClientHooks = {
    update: (notification, receivedAt) => {
      recorder.update(notification, receivedAt);
      configUpdates.observe(notification);
    },
    extension: (method, params, receivedAt, afterOpen) => {
      recorder.extension(method, profile.redactExtensionNotification?.(method, params) ?? params, afterOpen ?? opening.afterOpen(params), receivedAt);
    },
    requested: (id, method, params, receivedAt) => {
      recorder.requested(id, method, params, receivedAt);
    },
    answered: (id, reply) => {
      recorder.answered(id, reply);
    },
    extensionNotifications: profile.extensionNotifications ?? [],
  };
  return { terminalHost, usageGate, tokenUsage, opening, configUpdates, recorder, hooks, nativeTurns };
}
