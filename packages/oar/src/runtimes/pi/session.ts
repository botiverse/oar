import type { Session, StartSession, Turn } from "../../contracts/session.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel, type KernelTurn } from "../../shared/session-kernel.js";

/*
 * Bundled pi SDK mapping (in-process, no fork — settled 2026-08-21):
 * - createAgentSession({cwd}) → AgentSession; prompt(text) resolves when the
 *   run settles, steer(text) enqueues into the active run (applied at the next
 *   internal-turn boundary), abort() cancels cooperatively.
 * - steer `accepted` here means: the message entered pi's steering queue.
 *   No live steer probe yet (no provider key on this machine); generic
 *   behavior is covered by the mock behavior suite.
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
  if (options.resume !== undefined) {
    // pi resumes by session FILE (SessionManager.open(path)), not by bare id;
    // wiring the id→file lookup waits for a consumer with configured pi.
    throw new Error("pi session resume is not implemented yet");
  }
  if (options.env !== undefined) {
    // In-process runtime: env is process-global here, so a per-session
    // overlay cannot be honored — reject loudly rather than drop silently.
    throw new Error("pi runs in-process and cannot take per-session env");
  }
  const sdk = await import("@earendil-works/pi-coding-agent");
  const { session: piAgentSession } = await sdk.createAgentSession({ cwd: options.cwd });

  const kernel = createSessionKernel(piAgentSession.sessionId);
  let current: { turn: KernelTurn; abortRequested: boolean; adopted: boolean } | null = null;
  let disposed = false;

  piAgentSession.subscribe((event) => {
    // A run pi starts that we did not prompt (a drained followUp) still
    // becomes a real kernel turn; it settles on agent_end since no prompt
    // promise is attached to it.
    if (event.type === "agent_start" && kernel.active() === null) {
      const kernelTurn = kernel.begin();
      if (kernelTurn !== null) {
        current = { turn: kernelTurn, abortRequested: false, adopted: true };
      }
    }
    const state = current;
    if (state === null || state.turn.settled()) {
      return;
    }
    if (event.type === "agent_end" && state.adopted) {
      state.turn.settle(state.abortRequested ? { kind: "aborted" } : { kind: "completed" });
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

  const session: Session = sealSession({
    id: kernel.sessionId,
    prompt(input) {
      const turn = kernel.begin();
      if (turn === null) {
        return { kind: "busy" };
      }
      const state = { turn, abortRequested: false, adopted: false };
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
    queue: {
      durable: false,
      add: async (input) => {
        // followUp semantics: runs only when the agent would otherwise stop.
        await piAgentSession.prompt(input, { streamingBehavior: "followUp" });
      },
    },
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
  });
  return session;
};
