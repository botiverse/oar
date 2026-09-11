import type {
  ControlResult,
  RequestRecord,
  Session,
  StartSession,
} from "../../contracts/session.js";
import { randomUUID } from "node:crypto";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel } from "../../shared/session-kernel.js";
import {
  claudeAbortRequested,
  claudePrompted,
  foldClaudeStdout,
  initialClaudeProjection,
  type ClaudeProjectionState,
} from "./projection.js";

/*
 * Live semantics this adapter is built on (drydock probes, 2026-08-21):
 * - stdin accepts writes at every phase; a mid-turn write is delivered into
 *   the ACTIVE turn at the next model-step boundary (steer), or becomes the
 *   next turn when no step remains. Landing shows up in the event stream.
 * - each turn is framed by its own system/init … result pair; the `result`
 *   frame is claude's own turn end and becomes the turn_ended view.
 * - `control_request {subtype:"interrupt"}` is acked with control_response
 *   (the abort request's response record) and claude settles the turn with
 *   an error-subtype result.
 * - steer/prompt `accepted` here means: the user message was written to
 *   stdin. Landing (same turn vs auto-queued next turn) is claude's timing and
 *   shows up only in the stream. Live probe: claude-session-adapter.ts.
 */

function userMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

interface ClaudeSessionState {
  child: LineProcess;
  /** The prompt request whose turn is running; null while idle. Spontaneous turns (a drained queue message) run with no request. */
  active: RequestRecord | null;
  /** True while claude is executing a turn we did not prompt (queue drain). */
  spontaneous: boolean;
  projection: ClaudeProjectionState;
  disposed: boolean;
}

export const claudeSession: StartSession = async (installation, options) => {
  if (installation.via !== "executable") {
    throw new Error("The claude session adapter needs an executable installation");
  }
  // Session identity is claude's own: we either choose it up front
  // (--session-id) or reattach to an existing one (--resume), so Session.id
  // is always the runtime-native persistent id.
  const sessionId = options.resume ?? randomUUID();
  const child = spawnLineProcess(installation.command, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    // YOLO by default (repo policy, 2026-08-24): in embedded/SDK use there is
    // no human at an approval prompt — a permission gate is a hang, not
    // safety. Isolation is the sandbox's job, not the approval flow's.
    "--dangerously-skip-permissions",
    ...(options.resume === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.systemPrompt === undefined ? [] : ["--system-prompt", options.systemPrompt]),
    ...(options.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", options.appendSystemPrompt]),
  ], {
    cwd: options.cwd,
    env: { ...process.env, CLAUDECODE: undefined, ...options.env },
  });
  await child.spawned;

  const kernel = createSessionKernel(sessionId);
  const state: ClaudeSessionState = {
    child,
    active: null,
    spontaneous: false,
    projection: initialClaudeProjection,
    disposed: false,
  };
  // claude cannot hold input for a LATER turn natively (an active-turn write
  // steers), so queueing is adapter-held: drained one message per turn end.
  const heldQueue: string[] = [];
  const busy = (): boolean => state.active !== null || state.spontaneous;
  let disposeRequest: RequestRecord | null = null;

  // Drive the pure projection fold, applying its commands to the kernel. The
  // fold owns event translation and attribution; this owns only transport
  // and the control decisions (busy, queue drain).
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    // A system/init while nothing is active is claude starting a turn on its
    // own (a queued or late-steered message): a spontaneous turn.
    if (message.type === "system" && message.subtype === "init" && !busy()) {
      state.spontaneous = true;
    }
    const { state: nextProjection, commands } = foldClaudeStdout(state.projection, message);
    state.projection = nextProjection;
    let ended = false;
    for (const command of commands) {
      switch (command.kind) {
        case "event": {
          const record = kernel.event(command.body, { agentPath: command.agentPath });
          if (record.agentPath.length === 0 && command.body.views.some((view) => view.kind === "turn_ended")) {
            ended = true;
          }
          break;
        }
        case "respond":
          kernel.respond(command.requestId, command.body);
          break;
        case "toApp":
          kernel.request("toApp", { kind: "native", type: command.type, native: command.native }, { id: command.id });
          break;
        default:
          break;
      }
    }
    if (ended) {
      state.active = null;
      state.spontaneous = false;
      if (!state.disposed) {
        const next = heldQueue.shift();
        if (next !== undefined) {
          child.write(userMessage(next));
        }
      }
    }
  });
  child.onExit((code) => {
    // The exit is an outcome only oar observes: it answers our dispose when
    // we caused it, and stands alone when claude died on its own.
    kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
    state.active = null;
    state.spontaneous = false;
  });

  let interruptCounter = 0;
  const session: Session = sealSession({
    id: kernel.sessionId,
    capabilities: { steer: true, queue: { durable: false }, attribution: "attributed" },
    prompt: async (input): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "prompt", input }, (request) => {
      if (busy()) {
        return { kind: "rejected", reason: "busy" };
      }
      state.active = request;
      state.projection = claudePrompted(state.projection);
      child.write(userMessage(input));
      return { kind: "accepted" };
      });
      return result;
    },
    steer: async (input): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "steer", input }, () => {
      if (!busy()) {
        return { kind: "rejected", reason: "not_steerable: no active turn" };
      }
      child.write(userMessage(input));
      return { kind: "accepted" };
      });
      return result;
    },
    queue: async (input): Promise<ControlResult> => {
      const result = await kernel.control({ kind: "queue", input }, () => {
      if (busy()) {
        heldQueue.push(input);
      } else {
        child.write(userMessage(input));
      }
      return { kind: "accepted" };
      });
      return result;
    },
    abort: async (): Promise<ControlResult> => {
      // The interrupt's outcome is claude's control_response, which the fold
      // routes to THIS request id; the turn's end is claude's result frame.
      interruptCounter += 1;
      const requestId = `interrupt-${interruptCounter}`;
      // Recorded by hand (not kernel.control) because claude's control_response
      // is the answer, routed to this id by the fold — so the reachability gate
      // is applied here explicitly.
      const blocked = kernel.unreachable();
      const request = kernel.request("toRuntime", { kind: "abort" }, { id: requestId });
      if (blocked !== null || !busy()) {
        return { request, response: kernel.respond(request.id, blocked ?? { kind: "rejected", reason: "no active turn" }) };
      }
      state.projection = claudeAbortRequested(state.projection);
      const { promise, resolve } = Promise.withResolvers<ControlResult>();
      const unsubscribe = kernel.subscribe((record) => {
        if (record.kind === "response" && record.requestId === requestId) {
          resolve({ request, response: record });
        }
      });
      child.write(`${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt" },
      })}\n`);
      const result = await promise;
      unsubscribe();
      return result;
    },
    subscribe: (observer, cursor) => kernel.subscribe(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      if (state.disposed) {
        return;
      }
      state.disposed = true;
      const gone = kernel.unreachable() !== null; // only an observed exit can say so before this dispose is recorded
      disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
      if (gone) {
        // The exit is already recorded; nothing is left to release.
        kernel.respond(disposeRequest.id, { kind: "accepted" });
        return;
      }
      child.kill();
      await child.exited; // release point for anything the process held; the exit response is recorded by onExit
    },
  });
  return session;
};
