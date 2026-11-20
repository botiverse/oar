import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { disposePiAgentSession } from "./lifecycle.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { ModelRequest } from "../../contracts/model-request.js";

const formats = new Map([
  ["anthropic-messages", "anthropic.messages"],
  ["openai-completions", "openai.chat"],
  ["openai-responses", "openai.responses"],
]);

interface SavedRequest { readonly metadata: Omit<ModelRequest, "body">; readonly json: string }

export interface PiModelRequests {
  read(this: void): Promise<ModelRequest | null>;
  close(this: void): void;
}

function checkProvider(session: AgentSession): void {
  const api: unknown = session.model?.api;
  if (typeof api !== "string" || !formats.has(api)) {
    throw new UnsupportedOptionError("modelRequests", "The selected Pi model uses an API without verified provider-body capture");
  }
}

/** Run after Pi's user-extension transforms and return exactly their original result to Pi. */
function capturePiModelRequests(session: AgentSession): PiModelRequests {
  const transform = session.agent.onPayload;
  let latest: SavedRequest | Error | null = null;
  let closed = false;
  session.agent.onPayload = async (payload, model): Promise<unknown> => {
    const transformed = await transform?.(payload, model);
    if (closed) { return transformed; }
    const format = formats.get(model.api);
    if (format === undefined) {
      latest = new Error("Pi built the latest model request with an API whose provider body OAR cannot verify");
    } else {
      try {
        const json = JSON.stringify(transformed === undefined ? payload : transformed);
        latest = typeof json === "string"
          ? { json, metadata: { at: new Date().toISOString(), provider: model.provider, model: model.id, format } }
          : new Error("Pi did not expose a JSON request body");
      } catch { latest = new Error("Pi's model request body could not be captured as JSON"); }
    }
    return transformed;
  };
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- The session method returns a promise for an in-memory snapshot.
    read() {
      if (latest instanceof Error) { return Promise.reject(latest); }
      if (latest === null) { return Promise.resolve(null); }
      const body: unknown = JSON.parse(latest.json);
      return Promise.resolve({ ...latest.metadata, body });
    },
    close() { closed = true; latest = null; },
  };
}

/** A session_start hook can prompt or select a model before binding returns. */
export async function bindPiExtensions(
  session: AgentSession,
  bindings: Parameters<AgentSession["bindExtensions"]>[0],
  capture: boolean,
): Promise<PiModelRequests | null> {
  let requests: PiModelRequests | null = null;
  try {
    if (capture) { checkProvider(session); requests = capturePiModelRequests(session); }
    await session.bindExtensions(bindings);
    if (capture) { checkProvider(session); }
    return requests;
  } catch (error) {
    requests?.close();
    await disposePiAgentSession(session, session.isStreaming);
    throw error;
  }
}
