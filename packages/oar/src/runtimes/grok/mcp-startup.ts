import type { SessionOptions } from "../../contracts/session.js";
import type { AcpOpenReadiness } from "../../shared/acp/open-readiness.js";

/** Grok reports per-server status asynchronously around session-wide discovery completion. */
export function grokMcpStartup(options: SessionOptions): AcpOpenReadiness | undefined {
  const served = new Set(options.mcpServers?.flatMap(server =>
    "type" in server && server.origin === "serveMcpTools" ? [server.name] : []));
  if (served.size === 0) { return undefined; }

  // Notifications can precede the session/new or session/resume reply that reveals our id,
  // and `_x.ai/mcp/server_status` can arrive either before or after `_x.ai/mcp_initialized`.
  const failures = new Map<string, Error>();
  const ready = new Map<string, Set<string>>();
  const initialized = new Set<string>();
  let bound: string | undefined = undefined;
  let changed: (() => void) | undefined = undefined;
  let finished = false;

  const markStatus = (id: string, params: Record<string, unknown>): boolean => {
    const { name, status } = params;
    if (typeof name !== "string" || !served.has(name) || typeof status !== "string" || status === "initializing") { return false; }
    if (status === "ready") {
      const names = ready.get(id) ?? new Set<string>();
      names.add(name);
      ready.set(id, names);
      return true;
    }
    const reason = typeof params.reason === "string" ? params.reason : status;
    failures.set(id, new Error(`Grok served MCP server ${JSON.stringify(name)}: ${reason}`));
    return true;
  };

  return {
    method: "_x.ai/mcp_initialized",
    observe(method, params) {
      const id = params.sessionId;
      if (finished || typeof id !== "string" || (bound !== undefined && bound !== id)) { return; }
      if (method === "_x.ai/mcp_initialized") { initialized.add(id); }
      else if (method === "_x.ai/mcp/server_status") { if (!markStatus(id, params)) { return; } }
      else { return; }
      changed?.();
    },
    async wait(sessionId, signal) {
      bound = sessionId;
      const outcome = Promise.withResolvers<void>();
      changed = (): void => {
        const error = failures.get(sessionId);
        if (error !== undefined) { outcome.reject(error); }
        else if (initialized.has(sessionId) && (ready.get(sessionId)?.size ?? 0) === served.size) { outcome.resolve(); }
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
        ready.clear();
        failures.clear();
        signal.removeEventListener("abort", cancelled);
      }
    },
  };
}
