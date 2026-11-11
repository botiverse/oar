// BYOK change: Modified from OAR 95c6547 for the injected process and its bounded diagnostics (Apache-2.0).
import type { LineProcess } from "../codex/app-server-client.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { DSH_BRIDGE_PROTOCOL } from "./bridge.js";

/** Measured cold starts stay near one second; this bounds a stuck loader, not an ordinary start. */
export const DSH_READY_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

// BYOK change: the transport's bounded exit error replaces upstream diagnostics.
const stderrOf = (child: LineProcess): string => child.exitError?.().message ?? "";

export interface DshReady {
  readonly protocol: number;
  readonly services: JsonRecord;
}

/** The bridge's own refusal or a native exception, with the native error object retained. */
export class DshCommandError extends Error {
  override readonly name = "DshCommandError";
  readonly code: string | undefined;
  readonly capability: string | undefined;
  readonly native: JsonRecord;

  constructor(native: JsonRecord, code: string | undefined, capability: string | undefined) {
    super(typeof native.message === "string" ? native.message : "DSH refused the command");
    this.native = native;
    this.code = code;
    this.capability = capability;
  }
}

const textOf = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

export interface DshControl {
  readonly ready: Promise<DshReady>;
  request(this: void, method: string, fields?: JsonRecord, timeoutMs?: number): Promise<JsonRecord>;
}

/**
 * The bridge's JSON lines. Every line but a command answer goes to `receive` in
 * order, a line that is not an object included, so nothing the process said is lost.
 */
export function dshControl(child: LineProcess, receive: (message: JsonRecord) => void): DshControl {
  let sequence = 0;
  let ended = false;
  const pending = new Map<string, { resolve(value: JsonRecord): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<DshReady>();
  // A rejected startup may be observed only after the opening awaits it.
  void (async (): Promise<void> => { try { await ready; } catch { /* The opening reports it. */ } })();
  const readyTimer = setTimeout(() => { rejectReady(new Error(`DSH did not load the OAR bridge within ${String(DSH_READY_TIMEOUT_MS)} ms: ${stderrOf(child)}`)); }, DSH_READY_TIMEOUT_MS);
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message?.type === "response" && typeof message.id === "string") {
      const waiter = pending.get(message.id);
      if (waiter === undefined) { return; }
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if ("result" in message) { waiter.resolve(asRecord(message.result) ?? {}); return; }
      waiter.reject(new DshCommandError(asRecord(message.error) ?? {}, textOf(message.code), textOf(message.capability)));
      return;
    }
    receive(message ?? { type: "stdout", line });
    if (message?.type === "ready") {
      clearTimeout(readyTimer);
      if (message.protocol === DSH_BRIDGE_PROTOCOL) { resolveReady({ protocol: DSH_BRIDGE_PROTOCOL, services: asRecord(message.services) ?? {} }); }
      else { rejectReady(new Error(`The OAR bridge spoke protocol ${String(message.protocol)}, not ${String(DSH_BRIDGE_PROTOCOL)}`)); }
    } else if (message?.type === "startup-error") {
      clearTimeout(readyTimer);
      rejectReady(new DshCommandError(asRecord(message.error) ?? {}, textOf(message.code), textOf(message.capability)));
    }
  });
  child.onExit((code) => {
    ended = true;
    clearTimeout(readyTimer);
    const failure = new Error(`DSH exited (${String(code)}): ${stderrOf(child)}`);
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
      if (ended) { throw new Error("DSH has exited"); }
      sequence += 1;
      const id = `oar-dsh-${String(sequence)}`;
      const { promise, resolve, reject } = Promise.withResolvers<JsonRecord>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`DSH did not answer ${method} within ${String(timeoutMs)} ms: ${stderrOf(child)}`));
        child.kill();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.write(`${JSON.stringify({ ...fields, id, method })}\n`);
      const answer = await promise;
      return answer;
    },
  };
}
