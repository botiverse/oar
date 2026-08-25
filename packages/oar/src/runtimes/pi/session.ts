import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Session, StartSession, Turn } from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel, type KernelTurn } from "../../shared/session-kernel.js";
import {
  foldPiEvent,
  initialPiProjection,
  piAbortRequested,
  piPrompted,
  piSettledOutcome,
  type PiProjectionState,
} from "./projection.js";

/*
 * Bundled pi SDK mapping (in-process, no fork — settled 2026-08-21):
 * prompt resolves on settlement; steer acceptance means entry into pi's
 * queue; abort is cooperative. Turn deltas/tools map, session events drop.
 * Model selection needs ModelRuntime rather than options.model. Process-global
 * lazy env reads mean another embedded pi cannot safely share this process.
 */

/**
 * The bash tool that carries SessionOptions.env into the agent's spawned
 * processes: same builtin bash, plus a spawnHook overlaying the env. pi's
 * defineTool keeps the definition assignable to customTools, where it
 * replaces the builtin by name. Exported for direct unit verification.
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
  // OAR_PI_AGENT_DIR pins pi's global config home (models.json/auth.json/
  // settings) — same namespaced-env-pin pattern as OAR_CLAUDE_BIN. This is
  // how a host (or the pi-aimock behavior backend) points the in-process
  // model plane somewhere else.
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  // YOLO by default (repo policy): pi gates tool execution on project trust,
  // which is an approval prompt no embedded host can answer — pre-trust the
  // session cwd the same way pi's own Trust button would (auditable in
  // <agentDir>/trust.json).
  new sdk.ProjectTrustStore(agentDir ?? sdk.getAgentDir()).set(options.cwd, true);
  // System prompt seams: pi's DefaultResourceLoader natively supports both
  // replace (systemPrompt) and append (appendSystemPrompt).
  const wantsSystemPrompt = options.systemPrompt !== undefined || options.appendSystemPrompt !== undefined;
  const resourceLoader = wantsSystemPrompt
    ? new sdk.DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: agentDir ?? sdk.getAgentDir(),
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        ...(options.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [options.appendSystemPrompt] }),
      })
    : undefined;
  // A CALLER-provided loader is the caller's to load — createAgentSession
  // only reloads the one it builds itself.
  await resourceLoader?.reload();
  const { session: piAgentSession } = await sdk.createAgentSession({
    cwd: options.cwd,
    ...(agentDir === undefined ? {} : { agentDir }),
    ...(resourceLoader === undefined ? {} : { resourceLoader }),
    ...(overlay === undefined ? {} : { customTools: [await piEnvBashTool(options.cwd, overlay)] }),
  });

  const kernel = createSessionKernel(piAgentSession.sessionId);
  let currentTurn: KernelTurn | null = null;
  let projection: PiProjectionState = initialPiProjection;
  let disposed = false;
  // Adapter-held queue, drained one input per turn end. pi's native followUp
  // CONTINUES the active run (more internal turns, one agent_end), which
  // would land the queued input inside the same OAR turn — the queue contract
  // promises a later turn of its own, so the adapter owns the handoff.
  const held: string[] = [];
  const drainHeld = (): void => {
    if (disposed || kernel.active() !== null) {
      return;
    }
    const next = held.shift();
    if (next === undefined) {
      return;
    }
    // The run this starts is adopted as a spontaneous turn by agent_start.
    void (async (): Promise<void> => {
      try {
        await piAgentSession.prompt(next);
      } catch (error) {
        // Never drop a taken-over delivery silently: surface the loss as a
        // failed turn if one can still be attributed.
        const reason = error instanceof Error ? error.message : "queued prompt failed";
        kernel.begin()?.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
      }
    })();
  };

  // Drive the pure projection fold, applying its commands to the kernel; the
  // fold owns turn framing and event translation. Adopted turns settle in the
  // fold (agent_end); prompt-initiated turns settle in prompt() below.
  piAgentSession.subscribe((event) => {
    const { state: nextProjection, commands } = foldPiEvent(projection, event);
    projection = nextProjection;
    for (const command of commands) {
      switch (command.kind) {
        case "begin":
          currentTurn = kernel.begin();
          break;
        case "emit":
          currentTurn?.emit(command.body);
          break;
        case "settle":
          currentTurn?.settle(command.outcome);
          currentTurn = null;
          drainHeld();
          break;
        default:
          break;
      }
    }
  });

  const makeTurn = (turn: KernelTurn): Turn => ({
    id: turn.id,
    outcome: turn.outcome,
    abort: async () => {
      if (turn.settled()) {
        return;
      }
      projection = piAbortRequested(projection);
      await piAgentSession.abort();
      await turn.outcome;
    },
    steer: async (input) => {
      if (turn.settled()) {
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
      currentTurn = turn;
      projection = piPrompted();
      void (async (): Promise<void> => {
        try {
          await piAgentSession.prompt(input);
          turn.settle(piSettledOutcome(projection));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "pi prompt failed";
          turn.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
        }
        projection = initialPiProjection;
        currentTurn = null;
        drainHeld();
      })();
      return { kind: "turn", turn: makeTurn(turn) };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    contextUsage: () => {
      // pi is authoritative: getContextUsage() returns tokens (null right
      // after compaction, before the next response), contextWindow, percent.
      const usage = piAgentSession.getContextUsage();
      return usage === undefined
        ? null
        : { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
    },
    queue: {
      durable: false,
      add: async (input) => {
        await Promise.resolve();
        held.push(input);
        drainHeld();
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
