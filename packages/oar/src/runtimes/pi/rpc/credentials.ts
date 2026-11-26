import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { piReportedTools, type PiLoadedTool } from "../tools.js";

export interface PiRpcPipeHandlers {
  readonly remember: (key: string) => void;
  readonly failed: () => void;
  readonly config?: string;
  /** The tool list the child reported from its own session (`{ type: "tools" }`). */
  readonly tools?: (tools: readonly PiLoadedTool[]) => void;
}

function isConfigRequest(message: unknown): boolean {
  return typeof message === "object" && message !== null && !Array.isArray(message)
    && "type" in message && message.type === "config" && Object.keys(message).length === 1;
}

function isToolsReport(message: unknown): boolean {
  return typeof message === "object" && message !== null && !Array.isArray(message)
    && "type" in message && message.type === "tools" && "tools" in message && Array.isArray(message.tools);
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
    // A report the child pushes from its own session; it asks for nothing, and
    // an OAR that does not read it (no handler) still acknowledges the line.
    if (isToolsReport(message)) {
      handlers.tools?.(piReportedTools(message));
      return "ok";
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
