import type {
  PromptResult,
  Session,
  StartSession,
  Turn,
} from "../../contracts/session.js";
import { randomUUID } from "node:crypto";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel, type KernelTurn } from "../../shared/session-kernel.js";
import { ingestClaudeLine } from "./projection.js";

/*
 * Live semantics this adapter is built on (drydock probes, 2026-08-21):
 * - stdin accepts writes at every phase; a mid-turn write is delivered into
 *   the ACTIVE turn at the next model-step boundary (steer), or becomes the
 *   next turn when no step remains. Landing shows up in the event stream.
 * - each turn is framed by its own system/init … result pair.
 * - `control_request {subtype:"interrupt"}` is acked with control_response and
 *   settles the active turn with an error-subtype result.
 * - steer `accepted` here means: the user message was written to stdin.
 *   Landing (same turn vs auto-queued next turn) is claude's timing and shows
 *   up only in the event stream. Live probe: claude-session-adapter.ts.
 */

function userMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

interface ClaudeSessionState {
  child: LineProcess;
  turn: KernelTurn | null;
  abortPending: boolean;
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
  const state: ClaudeSessionState = { child, turn: null, abortPending: false, disposed: false };
  let interruptCounter = 0;
  // claude cannot hold input for a LATER turn natively (an active-turn write
  // steers), so queueing is adapter-held: drained one message per turn end.
  const heldQueue: string[] = [];

  child.onLine((line) => {
    const resultAtIdle = ingestClaudeLine(kernel, state, line);
    if (resultAtIdle && !state.disposed) {
      const next = heldQueue.shift();
      if (next !== undefined) {
        child.write(userMessage(next));
      }
    }
  });
  child.onExit(() => {
    const active = kernel.active();
    if (active !== null && !state.disposed) {
      active.settle({ kind: "failed", reason: "claude process exited", failure: "runtime_exited" });
    }
  });

  const makeTurn = (turn: KernelTurn): Turn => ({
    id: turn.id,
    outcome: turn.outcome,
    abort: async () => {
      if (turn.settled()) {
        return;
      }
      state.abortPending = true;
      interruptCounter += 1;
      child.write(`${JSON.stringify({
        type: "control_request",
        request_id: `interrupt-${interruptCounter}`,
        request: { subtype: "interrupt" },
      })}\n`);
      await turn.outcome;
    },
    steer: async (input) => {
      await Promise.resolve();
      if (turn.settled()) {
        return { kind: "not_steerable", reason: "turn already ended" };
      }
      child.write(userMessage(input));
      return { kind: "accepted" };
    },
  });

  const session: Session = sealSession({
    id: kernel.sessionId,
    prompt(input): PromptResult {
      const turn = kernel.begin();
      if (turn === null) {
        return { kind: "busy" };
      }
      state.turn = turn;
      child.write(userMessage(input));
      return { kind: "turn", turn: makeTurn(turn) };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    queue: {
      durable: false,
      add: async (input) => {
        await Promise.resolve();
        if (kernel.active() === null) {
          child.write(userMessage(input));
        } else {
          heldQueue.push(input);
        }
      },
    },
    dispose: async () => {
      if (state.disposed) {
        return;
      }
      state.disposed = true;
      kernel.active()?.settle({ kind: "aborted" });
      child.kill();
      await child.exited; // release point for anything the process held
    },
  });
  return session;
};
