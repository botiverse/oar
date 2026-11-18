import type { LineProcess } from "../executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../json.js";

/** Keep native controls outside this queue: their replies may be what settlement awaits. */
export function streamJsonResultReadback(child: LineProcess, callbacks: {
  consume(message: JsonRecord): boolean;
  exiting(code: number | null): void;
  before(): Promise<void> | void;
  process(message: JsonRecord, receivedAt: number): void;
  exited(code: number | null, reason?: string): void;
}): {
  listen(): void;
  settling(): boolean;
  hasExited(): boolean;
} {
  const buffered: { message: JsonRecord; receivedAt: number }[] = [];
  let settling = false;
  let exited = false;
  let deferredExit: { code: number | null; reason?: string } | null = null;
  const receive = (message: JsonRecord, receivedAt: number): void => {
    if (settling) { buffered.push({ message, receivedAt }); return; }
    const rootResult = message.type === "result" && (typeof message.parent_tool_use_id !== "string" || message.parent_tool_use_id.length === 0);
    if (rootResult && !exited) {
      settling = true;
      const waiting = callbacks.before();
      if (waiting !== undefined) {
        void (async (): Promise<void> => {
          try { await waiting; }
          finally {
            settling = false;
            callbacks.process(message, receivedAt);
            drain();
            if (deferredExit !== null) { callbacks.exited(deferredExit.code, deferredExit.reason); deferredExit = null; }
          }
        })();
        return;
      }
      settling = false;
    }
    callbacks.process(message, receivedAt);
  };
  function drain(): void {
    for (;;) {
      if (settling) { return; }
      const next = buffered.shift();
      if (next === undefined) { return; }
      receive(next.message, next.receivedAt);
    }
  }
  return {
    settling: () => settling, hasExited: () => exited,
    listen(): void {
      child.onLine(line => {
        const message = asRecord(parseJson(line));
        if (message !== null && !callbacks.consume(message)) { receive(message, Date.now()); }
      });
      child.onExit((code, reason) => {
        exited = true;
        // End awaited readbacks now; other controls must settle through promises,
        // not synchronously publish responses before the exit record.
        callbacks.exiting(code);
        if (settling) { deferredExit = { code, ...(reason === undefined ? {} : { reason }) }; }
        else { callbacks.exited(code, reason); }
      });
    },
  };
}
