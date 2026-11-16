import { sessionEnvironment } from "../../shared/environment.js";
/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import {
  client as createClient,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { startAcpProcess, withAcpDeadline } from "../../shared/acp/process.js";
import { hasAcpCapability } from "../../shared/acp/profile.js";
import { acpThoughtLevelOption } from "../../shared/acp/model.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { antigravityAcpArgs } from "./session.js";
import { antigravityVersionPreflight } from "./version.js";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Project a `session/new` response. agy CLI 1.5.0 has no model-list
 * method; the account's models ride on every new session as the
 * `configOptions` entry with id `model`, the option the session switches
 * through `session/set_config_option`. Its `thought_level` menu belongs only
 * to the current model. The legacy availableModels catalog enumerates
 * model/effort combinations for the other families without switching sessions.
 */
export function projectAntigravityModels(response: unknown): ModelEntry[] | undefined {
  const root = asRecord(response);
  const modelOption = asRecordList(root?.configOptions).find((option) => option.id === "model");
  if (modelOption === undefined) {
    return undefined;
  }
  // A new session's current model: what a session uses with no `model` set.
  const current = text(modelOption.currentValue);
  const thinking = acpThoughtLevelOption(root);
  const effortLevels = asRecordList(thinking?.options)
    .map((option) => text(option.value))
    .filter((value): value is string => value !== undefined);
  const defaultEffort = text(thinking?.currentValue);
  const entries: ModelEntry[] = [];
  for (const model of asRecordList(modelOption.options)) {
    const id = text(model.value);
    if (id === undefined) {
      continue;
    }
    const displayName = text(model.name);
    entries.push({
      id,
      ...(displayName === undefined || displayName === id ? {} : { displayName }),
      ...(id === current ? { default: true as const } : {}),
      ...(id === current && effortLevels.length > 0 ? { effortLevels } : {}),
      ...(id === current && defaultEffort !== undefined && effortLevels.includes(defaultEffort) ? { defaultEffort } : {}),
    });
  }
  return withCatalogEfforts(root, entries);
}

/** Never infer another model's menu from the current model's thought_level. */
function withCatalogEfforts(root: JsonRecord | null, entries: ModelEntry[]): ModelEntry[] {
  const available = asRecordList(asRecord(root?.models)?.availableModels);
  const levels = new Map<string, string[]>();
  const bareModels = new Set<string>();
  const unparsed: ModelEntry[] = [];
  for (const item of available) {
    const id = text(item.modelId);
    if (id === undefined) { continue; }
    if (entries.some(entry => entry.id === id)) { bareModels.add(id); continue; }
    const candidates = entries.filter(entry => id.startsWith(`${entry.id}-`) && id.length > entry.id.length + 1);
    const [family] = candidates;
    if (candidates.length === 1 && family !== undefined) {
      const value = id.slice(family.id.length + 1);
      const menu = levels.get(family.id) ?? [];
      if (!menu.includes(value)) { menu.push(value); }
      levels.set(family.id, menu);
    } else if (!unparsed.some(entry => entry.id === id)) {
      const displayName = text(item.name);
      unparsed.push({ id, ...(displayName === undefined || displayName === id ? {} : { displayName }),
        effortUnavailableReason: "Native model entry could not be associated with a unique model and effort." });
    }
  }
  const hasEfforts = levels.size > 0 || acpThoughtLevelOption(root) !== null;
  return [...entries.map(entry => {
    if (entry.effortLevels !== undefined) { return entry; }
    const menu = levels.get(entry.id);
    if (menu !== undefined) { return { ...entry, effortLevels: menu }; }
    return hasEfforts && !bareModels.has(entry.id) ? { ...entry, effortUnavailableReason: "Native catalog did not expose this model's effort menu." } : entry;
  }), ...unparsed];
}

async function readNewSession(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<JsonRecord> {
  const runtime = startAcpProcess(command, antigravityAcpArgs(env), createClient({ name: "oar" }), { cwd, env });
  try {
    const initialize = methods.agent.initialize;
    const initialized = asRecord(await withAcpDeadline(
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
    ));
    // Native configuration selects authentication; no login flow is started.
    const newSession = methods.agent.session.new;
    const response = await withAcpDeadline(
      runtime,
      newSession,
      timeoutMs,
      (requestOptions) => runtime.connection.agent.request<JsonRecord>(
        newSession,
        { cwd, mcpServers: [] },
        requestOptions,
      ),
    );
    const capabilities = asRecord(asRecord(initialized?.agentCapabilities)?.sessionCapabilities);
    if (typeof response.sessionId === "string" && hasAcpCapability(capabilities?.close)) {
      // Cleanup cannot erase a catalog already returned by session/new.
      await withAcpDeadline(runtime, methods.agent.session.close, timeoutMs, (requestOptions) => runtime.connection.agent.request(methods.agent.session.close, { sessionId: response.sessionId }, requestOptions)).catch(() => {});
    }
    return asRecord(response) ?? {};
  } finally {
    runtime.kill();
    await runtime.exited;
  }
}

export const antigravityListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "antigravity model listing requires the agy CLI executable" };
  }
  try {
    const env = sessionEnvironment(options.env);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const version = await antigravityVersionPreflight(installation, env, { timeoutMs });
    if (version.kind === "unsupported") { return version; }
    const response = await readNewSession(installation.command, listingCwd(options), version.timeoutMs, env);
    const models = projectAntigravityModels(response);
    if (models === undefined) {
      return { kind: "unsupported", reason: "this agy CLI build returns no model config option on session/new" };
    }
    return { kind: "ok", models };
  } catch (error) {
    if (error instanceof RequestError && (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message))) {
      return { kind: "unauthenticated", detail: error.message };
    }
    throw new Error("Failed to list Antigravity models", { cause: error });
  }
};
