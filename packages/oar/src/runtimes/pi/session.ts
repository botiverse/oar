import type { Session, StartSession, Turn } from "../../contracts/session.js";
import { createSessionKernel, type KernelTurn } from "../../shared/session-kernel.js";

/*
 * Bundled pi SDK mapping (in-process, no fork — settled 2026-08-21):
 * - createAgentSession({cwd}) → AgentSession; prompt(text) resolves when the
 *   run settles, steer(text) enqueues into the active run (applied at the next
 *   internal-turn boundary), abort() cancels cooperatively.
 * - Events: message_update carries AssistantMessageEvent text/thinking deltas;
 *   tool_execution_start/end map to tool calls. Session-scoped events
 *   (compaction, queue updates) have no turn and are dropped in v1.
 * - options.model is ignored for now: pi model selection needs its
 *   ModelRuntime objects, not a string; wire it when a consumer needs it.
 * - Process-global caveat: pi reads env like PI_PACKAGE_DIR lazily. An
 *   embedder already hosting another pi instance in the same process (e.g. a
 *   daemon that sets PI_PACKAGE_DIR for its own bundled pi) cannot safely run
 *   this adapter too — that is inherent to in-process SDKs, not worked around
 *   here.
 * - A missing provider key surfaces as the turn failing with the sdk's auth
 *   message — expected on machines that never configured pi.
 */

export const piSession: StartSession = async (installation, options) => {
  if (installation.via !== "bundled") {
    throw new Error("The pi session adapter needs the bundled sdk installation");
  }
  const sdk = await import("@earendil-works/pi-coding-agent");
  const { session: piAgentSession } = await sdk.createAgentSession({ cwd: options.cwd });

  const kernel = createSessionKernel();
  let current: { turn: KernelTurn; abortRequested: boolean } | null = null;
  let disposed = false;

  piAgentSession.subscribe((event) => {
    const state = current;
    if (state === null || state.turn.settled()) {
      return;
    }
    const turn = state.turn;
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta" && typeof inner.delta === "string") {
        turn.emit({ kind: "text_delta", text: inner.delta });
      } else if (inner.type === "thinking_delta" && typeof inner.delta === "string") {
        turn.emit({ kind: "thinking_delta", text: inner.delta });
      }
    } else if (event.type === "tool_execution_start") {
      turn.emit({
        kind: "tool_call_started",
        callId: event.toolCallId,
        tool: event.toolName,
      });
    } else if (event.type === "tool_execution_end") {
      turn.emit({ kind: "tool_call_ended", callId: event.toolCallId });
    }
  });

  const makeTurn = (state: { turn: KernelTurn; abortRequested: boolean }): Turn => ({
    id: state.turn.id,
    outcome: state.turn.outcome,
    abort: async () => {
      if (state.turn.settled()) {
        return;
      }
      state.abortRequested = true;
      await piAgentSession.abort();
      await state.turn.outcome;
    },
    steer: async (input) => {
      if (state.turn.settled()) {
        return { kind: "not_steerable", reason: "turn already ended" };
      }
      await piAgentSession.steer(input);
      return { kind: "accepted" };
    },
  });

  const session: Session = {
    id: kernel.sessionId,
    prompt(input) {
      const turn = kernel.begin();
      if (turn === null) {
        return { kind: "busy" };
      }
      const state = { turn, abortRequested: false };
      current = state;
      void (async (): Promise<void> => {
        try {
          await piAgentSession.prompt(input);
          turn.settle(state.abortRequested ? { kind: "aborted" } : { kind: "completed" });
        } catch (error) {
          turn.settle({
            kind: "failed",
            reason: error instanceof Error ? error.message : "pi prompt failed",
          });
        }
      })();
      return { kind: "turn", turn: makeTurn(state) };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const active = kernel.active();
      if (active !== null) {
        await piAgentSession.abort();
        active.settle({ kind: "aborted" });
      }
      piAgentSession.dispose();
    },
  };
  return session;
};
