import type { AvailableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";
import type { LineProcess } from "../../shared/executable/index.js";
import type { JsonRecord } from "../../shared/json.js";
import type { SessionCredentials } from "../../shared/session-credentials.js";
import { bootKapServer } from "./kap-boot.js";
import { assertAuthReady, ignoreRejection, verifyAgentOptions, type KapEndpoint } from "./kap-errors.js";
import { cleanupKapResources, createKapSessionRecord, resumeKapSessionRecord } from "./kap-negotiate.js";
import { hasRequiredKapCapabilities, KapApiError, kapRequest } from "./kap-protocol.js";
import { connectKapSocket, type KapSocket } from "./kap-socket.js";

export interface KapTransportHandlers {
  readonly onFrame: (frame: JsonRecord) => void;
  readonly onUnexpectedClose: () => void;
}

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

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(timeoutMessage));
  }, timeoutMs);
  timer.unref();
  try {
    const result = await Promise.race([promise, timeout.promise]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function openKapTransport(
  installation: AvailableInstallation,
  options: SessionOptions,
  credentials: SessionCredentials,
  handlers: KapTransportHandlers,
): Promise<KapNegotiationResult> {
  const started = await bootKapServer(installation, options, credentials);
  if (started.kind === "fallback_acp") {
    return { kind: "fallback_acp" };
  }

  const { cwd, child, boot, exitReason } = started;
  const endpoint: KapEndpoint = { origin: boot.origin, token: boot.token };
  let socket: KapSocket | null = null;
  let createdWorkspaceId: string | null = null;
  let closingIntentionally = false;
  const closeOnAbort = async (): Promise<void> => {
    closingIntentionally = true;
    const activeSocket = socket;
    const workspaceId = createdWorkspaceId;
    socket = null;
    createdWorkspaceId = null;
    await cleanupKapResources(child, endpoint, activeSocket, workspaceId);
  };
  const disposeTransport = async (): Promise<void> => {
    closingIntentionally = true;
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
    const initialTurnsBoundary = Promise.withResolvers<void>();
    void ignoreRejection(initialAgentSnapshot.promise);
    void ignoreRejection(initialTurnsBoundary.promise);
    let sawInitialAgent = false;
    let sawInitialTurns = false;
    const failBeforeReady = (reason: string): void => {
      if (!sawInitialAgent) {
        sawInitialAgent = true;
        initialAgentSnapshot.reject(new Error(reason));
      }
      if (!sawInitialTurns) {
        sawInitialTurns = true;
        initialTurnsBoundary.reject(new Error(reason));
      }
    };

    socket = await connectKapSocket(boot.wsUrl, boot.token, {
      onFrame: (frame) => {
        handlers.onFrame(frame);
        const isMainAgent = frame.agent_id === undefined || frame.agent_id === "main";
        if (!sawInitialAgent && frame.type === "agent" && isMainAgent) {
          sawInitialAgent = true;
          initialAgentSnapshot.resolve(frame);
        }
        if (!sawInitialTurns && isMainAgent) {
          if (frame.type === "turns") {
            sawInitialTurns = true;
            initialTurnsBoundary.resolve();
          } else if (frame.type === "turns.failed") {
            sawInitialTurns = true;
            const code = typeof frame.code === "number" ? frame.code : -1;
            const msg = typeof frame.msg === "string" ? frame.msg : "Failed to load initial Kimi KAP turns";
            initialTurnsBoundary.reject(new KapApiError(code, msg, 200, frame));
          }
        }
      },
      onClose: () => {
        if (!sawInitialAgent || !sawInitialTurns) {
          failBeforeReady("Kimi KAP WebSocket closed during initial session subscribe");
          return;
        }
        if (!closingIntentionally) {
          handlers.onUnexpectedClose();
        }
      },
    });

    await socket.command({ type: "subscribe", session_id: sessionId, agent_ids: ["main"] }, 15_000);
    const [agentState] = await Promise.all([
      waitWithTimeout(initialAgentSnapshot.promise, 15_000, "Timed out waiting for initial Kimi KAP agent snapshot"),
      waitWithTimeout(initialTurnsBoundary.promise, 15_000, "Timed out waiting for initial Kimi KAP turns boundary"),
    ]);
    if (socket.closed()) {
      throw new Error("Kimi KAP WebSocket closed during session open");
    }
    verifyAgentOptions(agentState, options);

    return { kind: "ready", sessionId, endpoint, child, socket, exitReason, closeOnAbort, disposeTransport };
  } catch (error) {
    await ignoreRejection(closeOnAbort());
    throw error;
  }
}
