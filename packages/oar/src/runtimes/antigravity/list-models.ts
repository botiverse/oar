/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import {
  client as createClient,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { startAcpProcess, withAcpDeadline } from "../../shared/acp/process.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { antigravityAcpArgs } from "./session.js";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Project a `session/new` response. agy_acp_server 1.2.1 has no model-list
 * method; the account's models ride on every new session as the
 * `configOptions` entry with id `model`, the option the session switches
 * through `session/set_config_option`. Effort is part of the model id
 * (`gemini-3.8-flash-high`, `-medium`, `-low`) and no `thought_level` option
 * exists, so no entry carries effort levels.
 */
export function projectAntigravityModels(response: unknown): ModelEntry[] | undefined {
  const modelOption = asRecordList(asRecord(response)?.configOptions).find((option) => option.id === "model");
  if (modelOption === undefined) {
    return undefined;
  }
  const entries: ModelEntry[] = [];
  for (const model of asRecordList(modelOption.options)) {
    const id = text(model.value);
    if (id === undefined) {
      continue;
    }
    const displayName = text(model.name);
    entries.push({ id, ...(displayName === undefined || displayName === id ? {} : { displayName }) });
  }
  return entries;
}

async function readNewSession(command: string, timeoutMs: number): Promise<JsonRecord> {
  const runtime = startAcpProcess(command, antigravityAcpArgs(), createClient({ name: "oar" }), { env: process.env });
  try {
    const initialize = methods.agent.initialize;
    await withAcpDeadline(
      runtime,
      initialize,
      timeoutMs,
      (requestOptions) => runtime.connection.agent.request(initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "oar", version: "0.0.0" },
      }, requestOptions),
    );
    // No `authenticate` and no `session/close`: the server signs in from its
    // own persisted login, and the process is killed once the list is read.
    const newSession = methods.agent.session.new;
    const response = await withAcpDeadline(
      runtime,
      newSession,
      timeoutMs,
      (requestOptions) => runtime.connection.agent.request<JsonRecord>(
        newSession,
        { cwd: process.cwd(), mcpServers: [] },
        requestOptions,
      ),
    );
    return asRecord(response) ?? {};
  } finally {
    runtime.kill();
    await runtime.exited;
  }
}

export const antigravityListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "antigravity model listing requires the agy_acp_server executable" };
  }
  try {
    const response = await readNewSession(installation.command, options.timeoutMs ?? 30_000);
    const models = projectAntigravityModels(response);
    if (models === undefined) {
      return { kind: "unsupported", reason: "this agy_acp_server build returns no model config option on session/new" };
    }
    return { kind: "ok", models };
  } catch (error) {
    if (error instanceof RequestError && (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message))) {
      return { kind: "unauthenticated", detail: error.message };
    }
    throw new Error("Failed to list Antigravity models", { cause: error });
  }
};
