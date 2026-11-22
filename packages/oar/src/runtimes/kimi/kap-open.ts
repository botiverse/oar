import type { AvailableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";
import type { LineProcess } from "../../shared/executable/index.js";
import type { JsonRecord } from "../../shared/json.js";
import type { SessionCredentials } from "../../shared/session-credentials.js";
import { bootKapServer } from "./kap-boot.js";
import { assertAuthReady, ignoreRejection, verifyAgentOptions, type KapEndpoint } from "./kap-errors.js";
import { cleanupKapResources, createKapSessionRecord, resumeKapSessionRecord } from "./kap-negotiate.js";
import { hasRequiredKapCapabilities, kapRequest } from "./kap-protocol.js";
import { connectKapSocket, type KapSocket } from "./kap-socket.js";

export type KapNegotiationResult =
  | { readonly kind: "fallback_acp" }
  | {
      readonly kind: "ready";
      readonly sessionId: string;
      readonly endpoint: KapEndpoint;
      readonly child: LineProcess;
      readonly socket: KapSocket;
      readonly exitReason: (reason: string | undefined) => string | undefined;
      readonly closeOnAbort: () => Promise<void>;
      readonly disposeTransport: () => Promise<void>;
    };

async function waitForInitialAgent(promise: Promise<JsonRecord>): Promise<JsonRecord> {
  const snapshot = await Promise.race([
    promise,
    new Promise<JsonRecord>((resolve) => {
      const timer = setTimeout(() => {
        resolve({});
      }, 2000);
      timer.unref();
    }),
  ]);
  return snapshot;
}

export async function openKapTransport(
  installation: AvailableInstallation,
  options: SessionOptions,
  credentials: SessionCredentials,
  onWsFrame: (frame: JsonRecord) => void,
): Promise<KapNegotiationResult> {
  const started = await bootKapServer(installation, options, credentials);
  if (started.kind === "fallback_acp") {
    return { kind: "fallback_acp" };
  }

  const { cwd, child, boot, exitReason } = started;
  const endpoint: KapEndpoint = { origin: boot.origin, token: boot.token };
  let socket: KapSocket | null = null;
  let createdWorkspaceId: string | null = null;
  const closeOnAbort = async (): Promise<void> => {
    const activeSocket = socket;
    const workspaceId = createdWorkspaceId;
    socket = null;
    createdWorkspaceId = null;
    await cleanupKapResources(child, endpoint, activeSocket, workspaceId);
  };
  const disposeTransport = async (): Promise<void> => {
    const activeSocket = socket;
    socket = null;
    createdWorkspaceId = null;
    await cleanupKapResources(child, endpoint, activeSocket, null);
  };

  try {
    const meta = await kapRequest(endpoint.origin, endpoint.token, "/meta", { timeoutMs: 10_000 });
    if (!hasRequiredKapCapabilities(meta)) {
      await closeOnAbort();
      return { kind: "fallback_acp" };
    }
    const auth = await kapRequest(endpoint.origin, endpoint.token, "/auth", { timeoutMs: 10_000 });
    assertAuthReady(auth);

    const agentConfig: JsonRecord = {
      permission_mode: "yolo",
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { thinking: options.effort }),
    };

    const sessionData = options.resume === undefined
      ? await createKapSessionRecord(endpoint, cwd, options, agentConfig, (workspaceId) => {
          createdWorkspaceId = workspaceId;
        })
      : await resumeKapSessionRecord(endpoint, cwd, options.resume, options, agentConfig);

    const sessionId = typeof sessionData.id === "string" && sessionData.id.length > 0 ? sessionData.id : options.resume;
    if (sessionId === undefined) {
      throw new Error("Kimi KAP create returned no session id");
    }

    const initialAgentSnapshot = Promise.withResolvers<JsonRecord>();
    let sawInitialAgent = false;
    socket = await connectKapSocket(boot.wsUrl, boot.token, {
      onFrame: (frame) => {
        if (!sawInitialAgent && frame.type === "agent" && (frame.agent_id === undefined || frame.agent_id === "main")) {
          sawInitialAgent = true;
          initialAgentSnapshot.resolve(frame);
        }
        onWsFrame(frame);
      },
      onClose: () => {
        if (!sawInitialAgent) {
          sawInitialAgent = true;
          initialAgentSnapshot.reject(new Error("Kimi KAP WebSocket closed during session subscribe"));
        }
      },
    });

    await socket.command({ type: "subscribe", session_id: sessionId, agent_ids: ["main"] }, 15_000);
    const agentState = await waitForInitialAgent(initialAgentSnapshot.promise);
    verifyAgentOptions(agentState, options);

    return { kind: "ready", sessionId, endpoint, child, socket, exitReason, closeOnAbort, disposeTransport };
  } catch (error) {
    await ignoreRejection(closeOnAbort());
    throw error;
  }
}
