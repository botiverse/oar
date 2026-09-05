import type { AgentSession as PiAgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Session, SessionOptions, StartSession, Turn } from "../../contracts/session.js";
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
import { piFindSessionFile, piResolveModel, piSessionDir } from "./resolve.js";

/*
 * Bundled pi SDK mapping (in-process, no fork — settled 2026-08-21):
 * prompt resolves on settlement; steer acceptance means entry into pi's
 * queue; abort is cooperative. Turn deltas/tools map, session events drop.
 * Resume opens the cwd's session file by id and options.model resolves
 * through the ModelRuntime (see resolve.ts). Process-global lazy env reads
 * mean another embedded pi cannot safely share this process.
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

/** The slice of pi's AgentSession the model read-back depends on; structural for tests. */
export interface PiModelSource {
  readonly model: { readonly provider: string; readonly id: string } | undefined;
}

/**
 * pi's `AgentSession.model` (SDK 0.84.2 agent-session.d.ts: "Current model
 * (may be undefined if not yet selected)") is the runtime-owned current
 * model, updated by setModel/model switching; spelled `provider/id` like the
 * list-models projection and pi's own `--model` flag.
 */
export function piEffectiveModel(session: PiModelSource): string | null {
  const { model } = session;
  return model === undefined ? null : `${model.provider}/${model.id}`;
}

/**
 * Opens (or resumes) the pi AgentSession the adapter wraps. Services first
 * (createAgentSessionServices loads the agent dir's extensions and their
 * provider registrations into the ModelRuntime, exactly as `pi` itself does),
 * then the session against an explicit SessionManager so resume and creation
 * share one session directory.
 */
async function openPiAgentSession(options: SessionOptions): Promise<PiAgentSession> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  // OAR_PI_AGENT_DIR pins pi's global config home (models.json/auth.json/
  // settings/sessions) — same namespaced-env-pin pattern as OAR_CLAUDE_BIN.
  // This is how a host (or the pi-aimock behavior backend) points the
  // in-process model plane somewhere else.
  const agentDir = process.env.OAR_PI_AGENT_DIR ?? sdk.getAgentDir();
  // YOLO by default (repo policy): pi gates tool execution on project trust,
  // which is an approval prompt no embedded host can answer — pre-trust the
  // session cwd the same way pi's own Trust button would (auditable in
  // <agentDir>/trust.json).
  new sdk.ProjectTrustStore(agentDir).set(options.cwd, true);
  const services = await sdk.createAgentSessionServices({
    cwd: options.cwd,
    agentDir,
    // System prompt seams: pi's DefaultResourceLoader natively supports both
    // replace (systemPrompt) and append (appendSystemPrompt).
    resourceLoaderOptions: {
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [options.appendSystemPrompt] }),
    },
  });
  // pi persists sessions per cwd under <agentDir>/sessions; the same
  // directory is used to create (so a later resume finds the file) and to
  // look a resumed id up.
  const sessionDir = piSessionDir(options.cwd, agentDir);
  const sessionManager = options.resume === undefined
    ? sdk.SessionManager.create(options.cwd, sessionDir)
    : sdk.SessionManager.open(
        await piFindSessionFile(sdk.SessionManager, options.resume, options.cwd, sessionDir),
        sessionDir,
      );
  // An explicit model wins over the one recorded in a resumed session
  // (sdk.js createAgentSession precedence, same in the services path); the
  // recorded one is restored only when none is given.
  const model = options.model === undefined ? undefined : piResolveModel(services.modelRuntime, options.model);
  // Per-session env on an in-process runtime: the runtime itself has no own
  // process, but the processes the AGENT spawns do — a bash tool built with a
  // spawnHook overlaying the env replaces the builtin by name (custom tools
  // win the SDK's tool registry). Provider config (keys, base URLs) does NOT
  // travel this way for pi; that needs its native modelRuntime/agentDir
  // channel.
  const overlay = options.env;
  const { session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    ...(model === undefined ? {} : { model }),
    ...(overlay === undefined ? {} : { customTools: [await piEnvBashTool(options.cwd, overlay)] }),
  });
  // Read back rather than trust the request: Session.model() is the
  // runtime's report, and a resume that kept the old model must not pass.
  const effective = piEffectiveModel(session);
  if (options.model !== undefined && effective !== options.model) {
    session.dispose();
    throw new Error(`pi did not apply model ${options.model}: the session reports ${effective ?? "no model"}`);
  }
  return session;
}

export const piSession: StartSession = async (installation, options) => {
  if (installation.via !== "bundled") {
    throw new Error("The pi session adapter needs the bundled sdk installation");
  }
  const piAgentSession = await openPiAgentSession(options);

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
    model: () => piEffectiveModel(piAgentSession),
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
