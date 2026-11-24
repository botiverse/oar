/* oxlint-disable import/max-dependencies, typescript/promise-function-async -- Model listing probes the gateway ACP surface and deadline callbacks return native SDK promises. */
import {
  client as createClient,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { startAcpProcess, withAcpDeadline } from "../../shared/acp/process.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { withQueryDeadline, type OwnQueryProcess } from "../../shared/executable/query.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { hermesAcpArgs } from "./session.js";

const LISTING = "Hermes model listing";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") { return undefined; }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The gateway publishes its picker as `models` (ACP's unstable session model
 * state) and, once a model is known, as a `model` select in `configOptions`.
 * Prefer `models`: it is the same state `session/list` and `session/resume`
 * read, and it carries the agent-side display names. The config option is the
 * fallback for owners that answer only config options.
 */
export function projectHermesModels(response: unknown): ModelEntry[] | undefined {
  const root = asRecord(response);
  const state = asRecord(root?.models);
  const current = text(state?.currentModelId);
  if (state !== null) {
    const models: ModelEntry[] = [];
    for (const entry of asRecordList(state.availableModels)) {
      const id = text(entry.modelId);
      if (id === undefined) { continue; }
      const displayName = text(entry.name);
      models.push({
        id,
        ...(displayName === undefined || displayName === id ? {} : { displayName }),
        ...(id === current ? { default: true as const } : {}),
      });
    }
    return models;
  }
  const option = asRecordList(root?.configOptions).find((entry) => entry.id === "model");
  if (option === undefined) { return undefined; }
  const configured = text(option.currentValue);
  const models: ModelEntry[] = [];
  for (const entry of asRecordList(option.options)) {
    const id = text(entry.value);
    if (id === undefined) { continue; }
    const displayName = text(entry.name);
    models.push({
      id,
      ...(displayName === undefined || displayName === id ? {} : { displayName }),
      ...(id === configured ? { default: true as const } : {}),
    });
  }
  return models;
}

async function readNewSession(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  own: OwnQueryProcess,
): Promise<ModelEntry[] | undefined> {
  // The gateway pushes `available_commands_update` and `config_option_update`
  // around the session reply. Register the standard update route so the SDK
  // accepts them; listing reads no update.
  const app = createClient({ name: "oar" }).onNotification(methods.client.session.update, () => {});
  const runtime = own(startAcpProcess(command, hermesAcpArgs, app, { cwd, env }));
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
  const newSession = methods.agent.session.new;
  const response = asRecord(await withAcpDeadline(
    runtime,
    newSession,
    timeoutMs,
    (requestOptions) => runtime.connection.agent.request<JsonRecord>(
      newSession,
      { cwd, mcpServers: [] },
      requestOptions,
    ),
  ));
  return response === null ? undefined : projectHermesModels(response);
}

export const hermesListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "Hermes model listing requires the hermes CLI executable" };
  }
  try {
    return await withQueryDeadline(LISTING, options.timeoutMs ?? 60_000, async (signal, own) => {
      signal.throwIfAborted();
      const models = await readNewSession(
        installation.command,
        listingCwd(options),
        options.timeoutMs ?? 60_000,
        sessionEnvironment(options.env),
        own,
      );
      if (models === undefined) {
        return {
          kind: "unauthenticated" as const,
          detail: "Hermes returned no model catalog; configure a provider with `hermes model` or `hermes setup`.",
        };
      }
      return { kind: "ok" as const, models };
    });
  } catch (error) {
    if (error instanceof RequestError && (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message))) {
      return { kind: "unauthenticated", detail: error.message };
    }
    throw new Error("Failed to list Hermes models", { cause: error });
  }
};
