import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AdapterSession, Session, SessionOptions } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import type { SessionCredentials } from "../../shared/session-credentials.js";
import { kimiKapCompaction } from "./kap-compaction.js";
import { createKapControls, KAP_SESSION_CAPABILITIES, type KapRuntimeState } from "./kap-controls.js";
import { createRuntimeState, processWsFrame } from "./kap-dispatch.js";
import { ignoreRejection } from "./kap-errors.js";
import { openKapTransport } from "./kap-open.js";
import { createKapProjection, type KapProjectionState } from "./kap-projection.js";

export type OpenKimiKapResult =
  | { readonly kind: "session"; readonly session: Session }
  | { readonly kind: "fallback_acp" };

export async function openKimiKapSession(
  installation: AvailableInstallation,
  options: SessionOptions,
  credentials: SessionCredentials,
): Promise<OpenKimiKapResult> {
  const bufferedRaw: JsonRecord[] = [];
  const pendingToApp = new Set<string>();
  const taskAgentById = new Map<string, string>();
  let projection: KapProjectionState | null = null;
  let state: KapRuntimeState | null = null;

  const onWsFrame = (rawFrame: JsonRecord): void => {
    if (projection === null || state === null) {
      bufferedRaw.push(rawFrame);
      return;
    }
    processWsFrame(projection, state, pendingToApp, rawFrame);
  };

  const opened = await openKapTransport(installation, options, credentials, onWsFrame);
  if (opened.kind === "fallback_acp") {
    return { kind: "fallback_acp" };
  }

  projection = createKapProjection(opened.sessionId);
  const activeKernel = credentials.kernel(opened.sessionId);
  const runtimeState = createRuntimeState(opened, activeKernel, taskAgentById);
  state = runtimeState;

  try {
    const compaction = kimiKapCompaction(
      activeKernel,
      opened.endpoint,
      opened.sessionId,
      () => runtimeState.activeRootTurn !== null || runtimeState.prompting || runtimeState.dispatching || runtimeState.held.length > 0,
    );

    for (const rawFrame of bufferedRaw.splice(0)) {
      processWsFrame(projection, runtimeState, pendingToApp, rawFrame);
    }

    opened.child.onExit((code, reason) => {
      runtimeState.abortFallback.clear();
      runtimeState.awaitingTurnStart = false;
      runtimeState.held.length = 0;
      activeKernel.processExited(code, opened.exitReason(reason));
    });

    const adapter: AdapterSession = {
      id: opened.sessionId,
      capabilities: KAP_SESSION_CAPABILITIES,
      ...createKapControls(runtimeState),
      compact: async (compactOptions) => {
        runtimeState.manualCompactionActive = true;
        try {
          return await compaction.compact(compactOptions);
        } finally {
          runtimeState.manualCompactionActive = false;
        }
      },
      rawEvents: (observer, cursor) => activeKernel.rawEvents(observer, cursor),
      records: () => activeKernel.records(),
      graph: () => activeKernel.graph(),
      resources: async () => {
        const res = await opened.child.resources();
        return res;
      },
      dispose: async (): Promise<void> => {
        await activeKernel.dispose(async () => {
          runtimeState.abortFallback.clear();
          runtimeState.awaitingTurnStart = false;
          runtimeState.held.length = 0;
          await opened.disposeTransport();
        });
      },
    };

    return { kind: "session", session: credentials.seal(adapter) };
  } catch (error) {
    await ignoreRejection(opened.closeOnAbort());
    throw error;
  }
}
