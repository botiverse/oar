import type {
  RequestRecord, ContextUsage, ControlResult, PromptOptions, ResponseBody, Session, StartSession } from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import {
  foldPiEvent,
  initialPiProjection,
  piAbortRequested,
  piPrompted,
  type PiProjectionState,
} from "./projection.js";
import { openPiAgentSession, piEffectiveModel } from "./open.js";

export { piEffectiveModel, piEnvBashTool, type PiModelSource } from "./open.js";

/*
 * Bundled pi SDK mapping (in-process, no fork; settled 2026-08-21, record
 * stream 2026-09-11): every SDK event is one event record; pi's own
 * `agent_settled` is the turn end; steer acceptance means entry into pi's queue;
 * abort is cooperative. Resume opens the cwd's session file by id and
 * options.model resolves through the ModelRuntime (see resolve.ts).
 * Process-global lazy env reads mean another embedded pi cannot safely share
 * this process.
 */

export const piSession: StartSession = async (installation, options) => {
  if (installation.via !== "bundled") {
    throw new Error("The pi session adapter needs the bundled sdk installation");
  }
  const piAgentSession = await openPiAgentSession(options);

  const kernel = createSessionKernel(piAgentSession.sessionId);
  let projection: PiProjectionState = initialPiProjection;
  // A run is in progress: from an accepted prompt (or a drained queue input,
  // or an adopted agent_start) until pi's own agent_settled. Held in an
  // object so closures always read the live value.
  const gate = { running: false };
  // Identity of the latest launched prompt, so a late rejection of an older
  // one cannot be misread as the current run's.
  let launch: object | null = null;
  // The dispose request once issued: dispose is idempotent on it. Liveness
  // itself is the kernel's business (kernel.unreachable() reads the stream).
  let disposeRequest: RequestRecord | null = null;
  // An abort taken over before pi created the run (pi's abort calls are no-ops
  // until then): delivered on agent_start.
  let pendingAbort = false;
  // Adapter-held queue, drained one input per run end. pi's native followUp
  // CONTINUES the active run (more internal turns, one agent_end), which
  // would land the queued input inside the same turn; the queue contract
  // promises a later turn of its own, so the adapter owns the handoff.
  const held: string[] = [];

  // pi is authoritative on context fullness: getContextUsage() returns
  // tokens (null right after compaction, before the next response),
  // contextWindow, percent. Read at agent_end so the turn-end record carries
  // it and Session.contextUsage() (a fold) is current at turn end (which
  // is agent_settled, after any threshold compaction; see projection.ts).
  const contextOf = (): ContextUsage | null => {
    const usage = piAgentSession.getContextUsage();
    return usage === undefined
      ? null
      : { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
  };

  // agent_start waiters: a prompt is `accepted` once pi actually starts the
  // run, `rejected` with pi's own message if pi refuses it first.
  const startWaiters = new Set<() => void>();
  const start = async (input: string): Promise<ResponseBody> => {
    gate.running = true;
    projection = piPrompted(projection);
    const token = {};
    launch = token;
    const { promise: started, resolve: onStarted } = Promise.withResolvers<void>();
    startWaiters.add(onStarted);
    const run = piAgentSession.prompt(input);
    const decided = await Promise.race<ResponseBody>([
      started.then(() => ({ kind: "accepted" })),
      run.then(
        () => ({ kind: "accepted" }),
        (error: unknown) => ({ kind: "rejected", reason: error instanceof Error ? error.message : "pi prompt failed" }),
      ),
    ]);
    startWaiters.delete(onStarted);
    if (decided.kind === "rejected") {
      gate.running = false;
      launch = null;
      return decided;
    }
    void (async (): Promise<void> => {
      try {
        await run;
      } catch (error) {
        // pi failed the run after starting it and without its own settlement.
        // That failure is pi's own word, recorded as an event carrying pi's
        // message, not a synthesized boundary; it ends the turn only when no
        // agent_settled already did.
        if (launch === token && gate.running) {
          const reason = error instanceof Error ? error.message : "pi prompt failed";
          gate.running = false;
          kernel.event({
            type: "pi/prompt_rejected",
            native: { message: reason },
            views: [{ kind: "turn_ended", outcome: { kind: "failed", reason, failure: classifyFailure(reason) } }],
          });
          drainHeld();
        }
      }
    })();
    return decided;
  };
  function drainHeld(): void {
    if (disposeRequest !== null || gate.running) {
      return;
    }
    const next = held.shift();
    if (next === undefined) {
      return;
    }
    void (async (): Promise<void> => {
      const decided = await start(next);
      if (decided.kind === "rejected") {
        // The queue took the input over; pi refusing it is not silent: pi's
        // refusal enters the stream (no turn ever started, so no turn end).
        kernel.event({ type: "pi/prompt_rejected", native: { message: decided.reason, input: next }, views: [] });
        drainHeld();
      }
    })();
  }

  // Drive the pure projection fold: one SDK event → one event record. The
  // fold owns views and outcome classification; this owns the run gate.
  piAgentSession.subscribe((event) => {
    if (event.type === "agent_start") {
      gate.running = true;
      for (const waiter of startWaiters) {
        waiter();
      }
      if (pendingAbort) {
        pendingAbort = false;
        piAgentSession.abortRetry();
        piAgentSession.agent.abort();
      }
    }
    const extra = event.type === "agent_settled" ? { context: contextOf() } : {};
    const { state: nextProjection, commands } = foldPiEvent(projection, event, extra);
    projection = nextProjection;
    for (const command of commands) {
      kernel.event(command.body);
      if (command.body.views.some((view) => view.kind === "turn_ended")) {
        gate.running = false;
        drainHeld();
      }
    }
  });

  const openedModel = piEffectiveModel(piAgentSession);
  if (openedModel !== null) {
    // The SDK's own report of the model in effect at open, captured as the
    // runtime's word (never the request echoed: the mismatch check above
    // already rejected a request pi did not apply).
    kernel.event({
      type: "pi/session_opened",
      native: { sessionId: piAgentSession.sessionId, model: openedModel },
      views: [{ kind: "model", model: openedModel }],
    });
  }

  const session: Session = sealSession({
    id: kernel.sessionId,
    capabilities: { steer: true, queue: { durable: false }, attribution: "none" },
    prompt: async (input, promptOptions?: PromptOptions): Promise<ControlResult> => {
      const body = { kind: "prompt" as const, input, ...(promptOptions?.lineage === undefined ? {} : { lineage: promptOptions.lineage }) };
      const result = await kernel.control(body, async () => {
        if (gate.running) {
          return { kind: "rejected", reason: "busy" };
        }
        const decided = await start(input);
        return decided;
      });
      return result;
    },
    steer: async (input): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "steer", input }, async () => {
        if (!gate.running) {
          return { kind: "rejected", reason: "not_steerable: no active turn" };
        }
        await piAgentSession.steer(input);
        return { kind: "accepted" };
      });
      return result;
    },
    queue: async (input): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "queue", input }, () => {
        held.push(input);
        drainHeld();
        return { kind: "accepted" };
      });
      return result;
    },
    abort: async (): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "abort" }, () => {
        if (!gate.running) {
          return { kind: "rejected", reason: "no active turn" };
        }
        projection = piAbortRequested(projection);
        // Delivery is pi's own AgentSession.abort() minus its idle wait (SDK
        // 0.84.2 agent-session.js: abortRetry(); agent.abort(); await
        // waitForIdle()); both calls are public and synchronous, and both
        // are no-ops until pi has created the run, so before agent_start the
        // intent is held and delivered there. Accepted means taken over; the
        // outcome is pi's own agent_settled on the stream.
        if (piAgentSession.isStreaming) {
          piAgentSession.abortRetry();
          piAgentSession.agent.abort();
        } else {
          pendingAbort = true;
        }
        return { kind: "accepted" };
      });
      return result;
    },
    subscribe: (observer, cursor) => kernel.subscribe(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      if (disposeRequest !== null) {
        return;
      }
      held.splice(0);
      const request = kernel.request("toRuntime", { kind: "dispose" });
      disposeRequest = request;
      if (gate.running) {
        // pi's own agent_settled (aborted) ends the turn in the stream.
        projection = piAbortRequested(projection);
        await piAgentSession.abort();
      }
      piAgentSession.dispose();
      // pi runs in this process: there is no process exit to observe, so the
      // dispose is answered as taken over rather than with an exit code.
      kernel.respond(request.id, { kind: "accepted" });
    },
  });
  return session;
};
