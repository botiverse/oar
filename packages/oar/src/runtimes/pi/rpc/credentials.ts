import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";

export interface PiRpcPipeHandlers {
  readonly remember: (key: string) => void;
  readonly failed: () => void;
  readonly config?: string;
}

function isConfigRequest(message: unknown): boolean {
  return typeof message === "object" && message !== null && !Array.isArray(message)
    && "type" in message && message.type === "config" && Object.keys(message).length === 1;
}

/** Serve one-time startup config and runtime provider keys over the private fd 3 pipe. */
export function servePiRpcPipe(pipe: Duplex, handlers: PiRpcPipeHandlers): void {
  const lines = createInterface({ input: pipe, crlfDelay: Infinity });
  let pendingConfig = handlers.config;
  const fail = (): void => { pendingConfig = undefined; handlers.failed(); };
  const reply = (line: string): string => {
    const message: unknown = JSON.parse(line);
    if (typeof message === "string") { pendingConfig = undefined; handlers.remember(message); return "ok"; }
    if (isConfigRequest(message) && pendingConfig !== undefined) {
      const payload = pendingConfig;
      pendingConfig = undefined;
      return payload;
    }
    throw new TypeError("Invalid Pi RPC private pipe message");
  };
  // readline forwards input errors to its own emitter. Both need listeners,
  // including when a child exits before the acknowledgment can be written.
  pipe.on("error", fail);
  lines.on("error", fail);
  lines.on("line", (line) => {
    try { pipe.write(`${reply(line)}\n`); } catch { fail(); }
  });
}

/** Register each private key before acknowledging the child's native hook. */
export function readPiRpcCredentials(pipe: Duplex, remember: (key: string) => void, failed: () => void): void {
  servePiRpcPipe(pipe, { remember, failed });
}
