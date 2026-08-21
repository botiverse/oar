import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
  PromptResult,
  Session,
  StartSession,
  Turn,
} from "../../contracts/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { createSessionKernel, type KernelTurn } from "../../shared/session-kernel.js";

/*
 * Live semantics this adapter is built on (drydock probes, 2026-08-21):
 * - stdin accepts writes at every phase; a mid-turn write is delivered into
 *   the ACTIVE turn at the next model-step boundary (steer), or becomes the
 *   next turn when no step remains. Landing shows up in the event stream.
 * - each turn is framed by its own system/init … result pair.
 * - `control_request {subtype:"interrupt"}` is acked with control_response and
 *   settles the active turn with an error-subtype result.
 */

function userMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

interface ClaudeSessionState {
  child: ChildProcessByStdio<Writable, Readable, null>;
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
  const kind = String(message.type);
  if (kind === "assistant") {
    for (const block of contentBlocks(message)) {
      if (block.type === "text" && typeof block.text === "string") {
        turn.emit({ kind: "text_delta", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        turn.emit({ kind: "thinking_delta", text: block.thinking });
      } else if (block.type === "tool_use") {
        turn.emit({
          kind: "tool_call_started",
          callId: typeof block.id === "string" ? block.id : "unknown",
          tool: typeof block.name === "string" ? block.name : "unknown",
        });
      }
    }
  } else if (kind === "user") {
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        turn.emit({ kind: "tool_call_ended", callId: block.tool_use_id });
      }
    }
  } else if (kind === "result") {
    if (state.abortPending) {
      state.abortPending = false;
      turn.settle({ kind: "aborted" });
    } else if (message.is_error === true) {
      const reason = typeof message.subtype === "string" ? message.subtype : "error";
      turn.settle({ kind: "failed", reason });
    } else {
      turn.settle({ kind: "completed" });
    }
  }
}

export const claudeSession: StartSession = async (installation, options) => {
  if (installation.via !== "executable") {
    throw new Error("The claude session adapter needs an executable installation");
  }
  const child = spawn(installation.command, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    ...(options.model === undefined ? [] : ["--model", options.model]),
  ], {
    cwd: options.cwd,
    env: { ...process.env, CLAUDECODE: undefined },
    stdio: ["pipe", "pipe", "ignore"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const kernel = createSessionKernel();
  const state: ClaudeSessionState = { child, turn: null, abortPending: false, disposed: false };
  let interruptCounter = 0;
  let buffer = "";

  child.stdout.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const message = raw.trim().length > 0 ? asRecord(parseJson(raw)) : null;
      if (message === null) {
        continue;
      }
      // A system/init with no active turn is claude starting a run on its own
      // (a steer that landed past the turn's end) — surface it as a real turn.
      if (message.type === "system" && message.subtype === "init" && kernel.active() === null) {
        state.turn = kernel.begin();
      }
      projectMessage(state, message);
    }
  });
  child.on("exit", () => {
    const active = kernel.active();
    if (active !== null && !state.disposed) {
      active.settle({ kind: "failed", reason: "claude process exited" });
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
      child.stdin.write(`${JSON.stringify({
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
      child.stdin.write(userMessage(input));
      return { kind: "accepted" };
    },
  });

  const session: Session = {
    id: kernel.sessionId,
    prompt(input): PromptResult {
      const turn = kernel.begin();
      if (turn === null) {
        return { kind: "busy" };
      }
      state.turn = turn;
      child.stdin.write(userMessage(input));
      return { kind: "turn", turn: makeTurn(turn) };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    dispose: async () => {
      if (state.disposed) {
        return;
      }
      state.disposed = true;
      kernel.active()?.settle({ kind: "aborted" });
      child.stdin.end();
      child.kill("SIGTERM");
      await Promise.resolve();
    },
  };
  return session;
};
