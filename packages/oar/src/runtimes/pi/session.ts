import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
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

/**
 * The bash tool that carries SessionOptions.env into the agent's spawned
 * processes: same builtin bash, plus a spawnHook overlaying the env. pi's
 * defineTool keeps the definition assignable to customTools, where it
 * replaces the builtin by name. Exported for the unit test that executes it
 * directly (no model needed to verify the overlay lands).
 */
export async function piEnvBashTool(
  cwd: string,
  overlay: Readonly<Record<string, string>>,
): Promise<NonNullable<CreateAgentSessionOptions["customTools"]>[number]> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  return sdk.defineTool(sdk.createBashToolDefinition(cwd, {
    spawnHook: (context) => ({ ...context, env: { ...context.env, ...overlay } }),
  }));
}

export const piSession: StartSession = async (installation, options) => {
  if (installation.via !== "bundled") {
    throw new Error("The pi session adapter needs the bundled sdk installation");
  }
  if (options.resume !== undefined) {
    // pi resumes by session FILE (SessionManager.open(path)), not by bare id;
    // wiring the id→file lookup waits for a consumer with configured pi.
    throw new Error("pi session resume is not implemented yet");
  }
  const sdk = await import("@earendil-works/pi-coding-agent");
  // Per-session env on an in-process runtime: the runtime itself has no own
  // process, but the processes the AGENT spawns do — a bash tool built with a
  // spawnHook overlaying the env replaces the builtin by name (custom tools
  // win the SDK's tool registry). Provider config (keys, base URLs) does NOT
  // travel this way for pi; that needs its native modelRuntime/agentDir
  // channel. Tool-level spawn verified in SDK source, not yet live (no
  // configured pi on this machine).
  const overlay = options.env;
  const { session: piAgentSession } = await sdk.createAgentSession({
    cwd: options.cwd,
    ...(overlay === undefined ? {} : { customTools: [await piEnvBashTool(options.cwd, overlay)] }),
  });

  const kernel = createSessionKernel(piAgentSession.sessionId);
  let current: { turn: KernelTurn; abortRequested: boolean; adopted: boolean } | null = null;
  let disposed = false;

  piAgentSession.subscribe((event) => {
    if (event.type === "agent_start") {
      // A run pi starts that we did not prompt (a drained followUp) still
      // becomes a real kernel turn; it settles on agent_end since no prompt
      // promise is attached to it.
      if (kernel.active() === null) {
        const kernelTurn = kernel.begin();
        if (kernelTurn !== null) {
          current = { turn: kernelTurn, abortRequested: false, adopted: true };
        }
      }
      return;
    }
    const state = current;
    if (state === null || state.turn.settled()) {
      return;
    }
    const turn = state.turn;
    // oxlint-disable-next-line switch-exhaustiveness-check -- deliberately partial: session-scoped events (compaction, queue, retries, …) have no turn mapping in v1 and are dropped
    switch (event.type) {
      case "agent_end": {
        if (state.adopted) {
          turn.settle(state.abortRequested ? { kind: "aborted" } : { kind: "completed" });
        }
        break;
      }
      case "message_update": {
        const inner = event.assistantMessageEvent;
        // oxlint-disable-next-line switch-exhaustiveness-check -- deliberately partial: only deltas map to v1 turn events
        switch (inner.type) {
          case "text_delta":
            turn.emit({ kind: "text_delta", text: inner.delta });
            break;
          case "thinking_delta":
            turn.emit({ kind: "thinking_delta", text: inner.delta });
            break;
          default:
            break;
        }
        break;
      }
      case "tool_execution_start": {
        turn.emit({
          kind: "tool_call_started",
          callId: event.toolCallId,
          tool: event.toolName,
        });
        break;
      }
      case "tool_execution_end": {
        turn.emit({ kind: "tool_call_ended", callId: event.toolCallId });
        break;
      }
      default:
        break;
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
