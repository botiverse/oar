import type {
  PromptResult,
  Session,
  StartSession,
  Turn,
} from "../../contracts/session.js";
import { randomUUID } from "node:crypto";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { sealSession } from "../../shared/seal-session.js";
import { createSessionKernel, type KernelTurn } from "../../shared/session-kernel.js";

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

function contentBlocks(message: JsonRecord): readonly JsonRecord[] {
  const inner = asRecord(message.message);
  const content = inner?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => asRecord(block)).filter((block) => block !== null);
}

function projectMessage(state: ClaudeSessionState, message: JsonRecord): void {
  const turn = state.turn;
  if (turn === null || turn.settled()) {
    return;
  }
  switch (String(message.type)) {
    case "assistant": {
      for (const block of contentBlocks(message)) {
        switch (String(block.type)) {
          case "text": {
            if (typeof block.text === "string") {
              turn.emit({ kind: "text_delta", text: block.text });
            }
            break;
          }
          case "thinking": {
            const content = typeof block.thinking === "string" && block.thinking.length > 0
              ? { kind: "text" as const, text: block.thinking }
              : { kind: "empty" as const };
            turn.emit({ kind: "reasoning", content });
            break;
          }
          case "redacted_thinking": {
            turn.emit({ kind: "reasoning", content: { kind: "redacted" } });
            break;
          }
          case "tool_use": {
            const started = {
              kind: "tool_call_started",
              callId: typeof block.id === "string" ? block.id : "unknown",
              tool: typeof block.name === "string" ? block.name : "unknown",
            } as const;
            const input = block.input === undefined ? undefined : JSON.stringify(block.input);
            turn.emit(input === undefined ? started : { ...started, input });
            break;
          }
          default:
            break;
        }
      }
      break;
    }
    case "user": {
      for (const block of contentBlocks(message)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const output = block.content === undefined ? undefined : JSON.stringify(block.content);
          turn.emit(output === undefined
            ? { kind: "tool_call_ended", callId: block.tool_use_id }
            : { kind: "tool_call_ended", callId: block.tool_use_id, output });
        }
      }
      break;
    }
    case "result": {
      settleFromResult(state, turn, message);
      break;
    }
    default:
      break;
  }
}

function settleFromResult(state: ClaudeSessionState, turn: KernelTurn, message: JsonRecord): void {
  if (state.abortPending) {
    state.abortPending = false;
    turn.settle({ kind: "aborted" });
    return;
  }
  if (message.is_error === true) {
    // Vendor quirk (pinned 2026-08-22): claude can report is_error=true with
    // subtype "success" and put the actual error text in result.
    const text = typeof message.result === "string" && message.result.length > 0
      ? message.result
      : undefined;
    const subtype = typeof message.subtype === "string" && message.subtype !== "success"
      ? message.subtype
      : undefined;
    const reason = text ?? subtype ?? "error";
    turn.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
    return;
  }
  turn.settle({ kind: "completed" });
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
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    // A system/init with no active turn is claude starting a run on its own
    // (a steer that landed past the turn's end) — surface it as a real turn.
    if (message.type === "system" && message.subtype === "init" && kernel.active() === null) {
      state.turn = kernel.begin();
    }
    projectMessage(state, message);
    if (message.type === "result" && kernel.active() === null && !state.disposed) {
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
