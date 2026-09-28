import type { RuntimeBrand } from "../contracts/brand.js";
import { defineRuntime, type Runtime } from "../contracts/runtime.js";
import type { InputOptions, RuntimeEventBody, Session, SessionOptions, StartSession, TokenTotals, TurnOutcome } from "../contracts/session.js";
// Built only on the public runtime-author SPI (@botiverse/oar/kernel), like any host's runtime.
import { createSessionKernel, sealSession } from "../kernel.js";

/**
 * What a script sees and does during one turn. Everything it emits enters the
 * record stream as frames of type `scripted/*`, read into the ordinary events
 * (`text_delta`, `reasoning`, `tool_call_*`), so a host exercises exactly the
 * paths a vendor runtime would drive.
 */
export interface ScriptedTurn {
  /** The input that began the turn: a prompt, or a queued input when its turn starts. */
  readonly input: string;
  /** The options the host opened the session with (cwd, env, system prompts). */
  readonly options: SessionOptions;
  /** Aborts when the host aborts the turn or disposes the session. */
  readonly signal: AbortSignal;
  /** Steer inputs delivered into this turn so far, oldest first. */
  readonly steered: readonly string[];
  /** Emit assistant text. */
  readonly say: (text: string) => void;
  /** Emit readable reasoning. */
  readonly think: (text: string) => void;
  /**
   * Run a tool: `tool_call_started`, then `run` (awaited), then
   * `tool_call_ended` carrying its result as output (`ok`), or the thrown
   * error's message (`failed`, and the error is rethrown to the script).
   */
  readonly tool: (name: string, input: string, run?: () => unknown) => Promise<void>;
}

export interface ScriptedRuntimeOptions {
  /** Registry id; default `scripted`. */
  readonly id?: string;
  readonly brand?: RuntimeBrand;
  /** Reported as the session's model; default `scripted-1`. */
  readonly model?: string;
  /**
   * One turn of behavior. Resolving ends the turn `completed`; throwing ends
   * it `failed` with the error message; an aborted signal ends it `aborted`
   * (the script should stop working when it sees the signal).
   */
  readonly turn: (turn: ScriptedTurn) => void | Promise<void>;
}

const tokensOf = (text: string): number => Math.ceil(text.length / 4);

/**
 * A runtime whose model is a script: for hosts' tests and demos that need a
 * real `Session` (the same records, folds and control semantics as a vendor
 * runtime) without a binary, a login or a provider. Capabilities: steer,
 * a non-durable queue, no sub-agents. Installation is always `bundled`.
 */
export function scriptedRuntime(options: ScriptedRuntimeOptions): Runtime {
  const id = options.id ?? "scripted";
  const model = options.model ?? "scripted-1";
  const start: StartSession = async (_installation, sessionOptions): Promise<Session> => {
    await Promise.resolve();
    const kernel = createSessionKernel(sessionOptions.resume);
    const queued: string[] = [];
    const totals: { input: number; output: number } = { input: 0, output: 0 };
    let active: { controller: AbortController; steered: string[] } | null = null;
    let disposed = false;

    const frame = (type: string, native: unknown, events: readonly RuntimeEventBody[]): void => {
      kernel.frame({ type, native, events });
    };
    const usage = (): TokenTotals => ({ input: totals.input, output: totals.output });

    function run(input: string): void {
      const controller = new AbortController();
      const steered: string[] = [];
      const turnState = { controller, steered };
      active = turnState;
      totals.input += tokensOf(input);
      let callSeq = 0;
      const live = (): boolean => active === turnState && !controller.signal.aborted;
      const turn: ScriptedTurn = {
        input,
        options: sessionOptions,
        signal: controller.signal,
        steered: turnState.steered,
        say: (text) => {
          if (!live()) {
            return;
          }
          totals.output += tokensOf(text);
          frame("scripted/text", { text }, [{ kind: "text_delta", text }]);
        },
        think: (text) => {
          if (!live()) {
            return;
          }
          frame("scripted/reasoning", { text }, [{ kind: "reasoning", content: { kind: "text", text } }]);
        },
        tool: async (name, toolInput, work) => {
          if (!live()) {
            return;
          }
          callSeq += 1;
          const callId = `call-${String(callSeq)}`;
          frame("scripted/tool_start", { callId, name, input: toolInput }, [{ kind: "tool_call_started", callId, tool: name, input: toolInput }]);
          try {
            const result: unknown = await work?.();
            const output = typeof result === "string" || result === undefined ? result : JSON.stringify(result);
            frame("scripted/tool_end", { callId, output, result: "ok" }, [{ kind: "tool_call_ended", callId, result: "ok", ...(output === undefined ? {} : { output }) }]);
          } catch (error) {
            const output = error instanceof Error ? error.message : String(error);
            frame("scripted/tool_end", { callId, output, result: "failed" }, [{ kind: "tool_call_ended", callId, result: "failed", output }]);
            throw error;
          }
        },
      };
      // The turn starts once the control that began it is answered, as with a vendor runtime:
      // the accepted response precedes the turn's first event.
      setImmediate(() => {
        void (async (): Promise<void> => {
          end(turnState, await settle(turn, controller.signal));
        })();
      });
    }

    async function settle(turn: ScriptedTurn, signal: AbortSignal): Promise<TurnOutcome> {
      try {
        await options.turn(turn);
        return signal.aborted ? { kind: "aborted" } : { kind: "completed" };
      } catch (error) {
        return signal.aborted
          ? { kind: "aborted" }
          : { kind: "failed", reason: error instanceof Error ? error.message : String(error), failure: "unknown" };
      }
    }

    function end(turnState: NonNullable<typeof active>, outcome: TurnOutcome): void {
      if (active !== turnState) {
        return; // already ended (an abort or dispose ended it first)
      }
      active = null;
      frame("scripted/end", { outcome }, [
        { kind: "turn_ended", outcome },
        { kind: "usage", usage: { tokens: usage(), context: { tokens: totals.input + totals.output, contextWindow: 200_000, percent: ((totals.input + totals.output) / 200_000) * 100 } } },
      ]);
      const next = queued.shift();
      if (next !== undefined && !disposed) {
        run(next);
      }
    }

    function abortActive(): void {
      const turnState = active;
      if (turnState === null) {
        return;
      }
      turnState.controller.abort();
      end(turnState, { kind: "aborted" });
    }

    frame("scripted/model", { model }, [{ kind: "model", model }]);
    return sealSession({
      id: kernel.sessionId,
      capabilities: { steer: true, queue: { durable: false }, attribution: "none" },
      prompt: async (input, inputOptions?: InputOptions) => {
        const result = await kernel.control({ kind: "prompt", input, ...inputOptions }, () => {
          if (active !== null) {
            return { kind: "rejected", code: "busy", reason: "busy" };
          }
          run(input);
          return { kind: "accepted" };
        });
        return result;
      },
      steer: async (input, inputOptions) => {
        const result = await kernel.control({ kind: "steer", input, ...inputOptions }, () => {
          if (active === null) {
            return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
          }
          active.steered.push(input);
          return { kind: "accepted" };
        });
        return result;
      },
      queue: async (input, inputOptions) => {
        const result = await kernel.control({ kind: "queue", input, ...inputOptions }, () => {
          if (active === null) {
            run(input);
          } else {
            queued.push(input);
          }
          return { kind: "accepted" };
        });
        return result;
      },
      abort: async () => {
        const result = await kernel.control({ kind: "abort" }, () => {
          if (active === null) {
            return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
          }
          abortActive();
          return { kind: "accepted" };
        });
        return result;
      },
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const request = kernel.request("toRuntime", { kind: "dispose" });
        queued.length = 0;
        abortActive();
        kernel.respond(request.id, { kind: "exited", code: 0 });
        await Promise.resolve();
      },
    });
  };
  return defineRuntime({
    id,
    ...(options.brand === undefined ? {} : { brand: options.brand }),
    session: start,
    installation: async () => {
      await Promise.resolve();
      return { kind: "available" as const, via: "bundled" as const };
    },
  });
}
