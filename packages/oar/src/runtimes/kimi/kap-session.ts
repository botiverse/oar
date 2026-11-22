import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AdapterSession, Session, SessionOptions } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import type { SessionCredentials } from "../../shared/session-credentials.js";
import { kimiKapCompaction } from "./kap-compaction.js";
import { createKapControls, isKapTurnBusy, KAP_SESSION_CAPABILITIES, scheduleDrainHeld, type KapRuntimeState } from "./kap-controls.js";
import { createRuntimeState, processWsFrame } from "./kap-dispatch.js";
import { ignoreRejection } from "./kap-errors.js";
import { openKapTransport } from "./kap-open.js";
import { createKapProjection, type KapProjectionState } from "./kap-projection.js";

function alwaysFalse(): boolean {
  return false;
}

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
  type OwnedChild = Extract<Awaited<ReturnType<typeof openKapTransport>>, { readonly kind: "ready" }>["child"];
  let openedChild: OwnedChild | null = null;
  let unexpectedWsClose = false;
  let intentionallyDisposing = false;

  const onWsFrame = (rawFrame: JsonRecord): void => {
    if (projection === null || state === null) {
      bufferedRaw.push(rawFrame);
      return;
    }
    processWsFrame(projection, state, pendingToApp, rawFrame);
  };

  const killOwnedChild = (): void => {
    if (openedChild !== null && !openedChild.stopping() && openedChild.diagnostics().exitCode === null) {
      openedChild.kill();
    }
  };

  const onUnexpectedClose = (): void => {
    if (intentionallyDisposing || unexpectedWsClose) { return; }
    unexpectedWsClose = true;
    if (state !== null) {
      state.abortFallback.clear();
      state.awaitingTurnStart = false;
      state.activeRootPromptId = null;
      state.pendingSteers.length = 0;
      state.held.length = 0;
    }
    killOwnedChild();
  };

  const opened = await openKapTransport(installation, options, credentials, { onFrame: onWsFrame, onUnexpectedClose });
  if (opened.kind === "fallback_acp") {
    return { kind: "fallback_acp" };
  }

  projection = createKapProjection(opened.sessionId);
  const activeKernel = credentials.kernel(opened.sessionId);
  const compactionBusyRef: { fn: () => boolean } = { fn: alwaysFalse };
  const runtimeState = createRuntimeState(opened, activeKernel, taskAgentById, (): boolean => compactionBusyRef.fn());
  state = runtimeState;
  openedChild = opened.child;

  try {
    const compaction = kimiKapCompaction(activeKernel, {
      origin: opened.endpoint.origin,
      token: opened.endpoint.token,
      sessionId: opened.sessionId,
      busy: () => isKapTurnBusy(runtimeState) || runtimeState.held.length > 0,
      released: () => { scheduleDrainHeld(runtimeState); },
      isSocketClosed: () => opened.socket.closed(),
    });
    compactionBusyRef.fn = (): boolean => compaction.busy();

    for (const rawFrame of bufferedRaw.splice(0)) {
      processWsFrame(projection, runtimeState, pendingToApp, rawFrame);
    }

    opened.child.onExit((code, reason) => {
      runtimeState.abortFallback.clear();
      runtimeState.awaitingTurnStart = false;
      runtimeState.activeRootPromptId = null;
      runtimeState.pendingSteers.length = 0;
      runtimeState.held.length = 0;
      const baseReason = opened.exitReason(reason);
      const exitDetail = unexpectedWsClose
        ? (baseReason === undefined ? "Kimi KAP WebSocket closed unexpectedly" : `Kimi KAP WebSocket closed unexpectedly (${baseReason})`)
        : baseReason;
      activeKernel.processExited(code, exitDetail);
    });
    if (opened.socket.closed()) {
      unexpectedWsClose = true;
      killOwnedChild();
    }

    const adapter: AdapterSession = {
      id: opened.sessionId,
      capabilities: KAP_SESSION_CAPABILITIES,
      ...createKapControls(runtimeState),
      compact: compaction.compact,
      rawEvents: (observer, cursor) => activeKernel.rawEvents(observer, cursor),
      records: () => activeKernel.records(),
      graph: () => activeKernel.graph(),
      resources: async () => {
        const res = await opened.child.resources();
        return res;
      },
      dispose: async (): Promise<void> => {
        intentionallyDisposing = true;
        await activeKernel.dispose(async () => {
          runtimeState.abortFallback.clear();
          runtimeState.awaitingTurnStart = false;
          runtimeState.activeRootPromptId = null;
          runtimeState.pendingSteers.length = 0;
          runtimeState.held.length = 0;
          await opened.disposeTransport();
        });
      },
    };

    return { kind: "session", session: credentials.seal(adapter) };
  } catch (error) {
    intentionallyDisposing = true;
    await ignoreRejection(opened.closeOnAbort());
    throw error;
  }
}
