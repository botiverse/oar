import type { SessionOptions } from "../../contracts/session.js";
import type { AcpOpenReadiness } from "../../shared/acp/open-readiness.js";

/** Grok reports the handshake by name, then completes discovery for the whole session. */
export function grokMcpStartup(options: SessionOptions): AcpOpenReadiness | undefined {
  const served = new Set(options.mcpServers?.flatMap(server =>
    "type" in server && server.origin === "serveMcpTools" ? [server.name] : []));
  if (served.size === 0) { return undefined; }

  // Notifications can precede the session/new reply that tells us our own id.
  const failures = new Map<string, Error>();
  const initialized = new Set<string>();
  let bound: string | undefined = undefined;
  let changed: (() => void) | undefined = undefined;
  let finished = false;
  return {
    method: "_x.ai/mcp_initialized",
    observe(method, params) {
      const id = params.sessionId;
      if (finished || typeof id !== "string" || (bound !== undefined && bound !== id)) { return; }
      if (method === "_x.ai/mcp_initialized") { initialized.add(id); }
      else if (method === "_x.ai/mcp/server_status" && params.status === "unavailable" && typeof params.name === "string" && served.has(params.name)) {
        const reason = typeof params.reason === "string" ? params.reason : "unavailable";
        failures.set(id, new Error(`Grok served MCP server ${JSON.stringify(params.name)}: ${reason}`));
      } else { return; }
      changed?.();
    },
    async wait(sessionId, signal) {
      bound = sessionId;
      const outcome = Promise.withResolvers<void>();
      changed = (): void => {
        const error = failures.get(sessionId);
        if (error !== undefined) { outcome.reject(error); }
        else if (initialized.has(sessionId)) { outcome.resolve(); }
      };
      const cancelled = (): void => { outcome.reject(signal.reason); };
      try {
        signal.throwIfAborted();
        signal.addEventListener("abort", cancelled, { once: true });
        changed();
        await outcome.promise;
      } finally {
        finished = true;
        changed = undefined;
        initialized.clear();
        failures.clear();
        signal.removeEventListener("abort", cancelled);
      }
    },
  };
}
