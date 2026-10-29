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
import { acpThoughtLevelOption } from "../../shared/acp/model.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";


function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** CodeBuddy 2.178.1 returns the model menu and current selection on session/new.
 * The thought-level menu belongs to that current model only. */
export function projectCodebuddyModels(response: unknown): ModelEntry[] | undefined {
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
    .filter((value): value is string => value !== undefined && value !== "enabled" && value !== "disabled");
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
  return entries;
}

async function readNewSession(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<JsonRecord> {
  const runtime = startAcpProcess(command, ["--acp", "--permission-mode", "bypassPermissions"], createClient({ name: "oar" }), { cwd, env });
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
    // No `authenticate` or `session/close`: the server reads its
    // own persisted login, and the process is killed once the list is read.
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
    return asRecord(response) ?? {};
  } finally {
    runtime.kill();
    await runtime.exited;
  }
}

export const codebuddyListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "codebuddy model listing requires the CodeBuddy executable" };
  }
  try {
    const response = await readNewSession(installation.command, listingCwd(options), options.timeoutMs ?? 30_000, sessionEnvironment(options.env));
    const models = projectCodebuddyModels(response);
    if (models === undefined) {
      return { kind: "unsupported", reason: "this CodeBuddy build returns no model config option on session/new" };
    }
    return { kind: "ok", models };
  } catch (error) {
    if (error instanceof RequestError && (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message))) {
      return { kind: "unauthenticated", detail: "CodeBuddy requires authentication" };
    }
    // oxlint-disable-next-line eslint/preserve-caught-error -- Native errors may contain credentials or account details.
    throw new Error("Failed to list CodeBuddy models");
  }
};
