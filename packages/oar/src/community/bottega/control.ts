import type { LineProcess } from "../../shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

/** The protocol `bottega serve` announces in its `ready` line (bottega/src/serve.ts). */
export const BOTTEGA_SERVE_PROTOCOL = 1;
/** A cold start loads the apps; this bounds a process that never says `ready`, not an ordinary start. */
const READY_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

/** A command bottega refused, with its own code (`busy`, `no_active_turn`, `session_not_found`, ...) and error object. */
export class BottegaCommandError extends Error {
  override readonly name = "BottegaCommandError";
  readonly code: string | undefined;
  readonly native: JsonRecord;

  constructor(native: JsonRecord) {
    super(typeof native.message === "string" ? native.message : "bottega refused the command");
    this.native = native;
    this.code = typeof native.code === "string" ? native.code : undefined;
  }
}

export interface BottegaReady {
  readonly protocol: number;
  readonly version: string | undefined;
}

export interface BottegaControl {
  readonly ready: Promise<BottegaReady>;
  request(this: void, method: string, fields?: JsonRecord, timeoutMs?: number): Promise<JsonRecord>;
}

/**
 * The JSON lines of `bottega serve`. A command answer settles its request;
 * every other line goes to `receive` in order, one that is not an object
 * included, so nothing the process said is lost.
 */
export function bottegaControl(child: LineProcess, receive: (message: JsonRecord) => void): BottegaControl {
  let sequence = 0;
  let ended = false;
  const pending = new Map<string, { resolve(value: JsonRecord): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<BottegaReady>();
  // A rejected startup may be observed only after the opening awaits it.
  void (async (): Promise<void> => { try { await ready; } catch { /* The opening reports it. */ } })();
  const readyTimer = setTimeout(() => {
    rejectReady(new Error(`bottega serve did not say ready within ${String(READY_TIMEOUT_MS)} ms: ${child.diagnostics().stderr}`));
  }, READY_TIMEOUT_MS);
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message?.type === "response" && typeof message.id === "string") {
      const waiter = pending.get(message.id);
      if (waiter === undefined) { return; }
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if ("result" in message) { waiter.resolve(asRecord(message.result) ?? {}); return; }
      waiter.reject(new BottegaCommandError(asRecord(message.error) ?? {}));
      return;
    }
    receive(message ?? { type: "stdout", line });
    if (message?.type === "ready") {
      clearTimeout(readyTimer);
      if (message.protocol === BOTTEGA_SERVE_PROTOCOL) {
        resolveReady({ protocol: BOTTEGA_SERVE_PROTOCOL, version: typeof message.version === "string" ? message.version : undefined });
      } else {
        rejectReady(new Error(`bottega serve spoke protocol ${String(message.protocol)}, not ${String(BOTTEGA_SERVE_PROTOCOL)}`));
      }
    }
  });
  child.onExit((code) => {
    ended = true;
    clearTimeout(readyTimer);
    const failure = new Error(`bottega exited (${String(code)}): ${child.diagnostics().stderr}`);
    rejectReady(failure);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
    pending.clear();
  });
  return {
    ready,
    request: async (method, fields = {}, timeoutMs = COMMAND_TIMEOUT_MS) => {
      if (ended) { throw new Error("bottega has exited"); }
      sequence += 1;
      const id = `oar-bottega-${String(sequence)}`;
      const { promise, resolve, reject } = Promise.withResolvers<JsonRecord>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`bottega did not answer ${method} within ${String(timeoutMs)} ms: ${child.diagnostics().stderr}`));
        child.kill();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.write(`${JSON.stringify({ ...fields, id, method })}\n`);
      const answer = await promise;
      return answer;
    },
  };
}
