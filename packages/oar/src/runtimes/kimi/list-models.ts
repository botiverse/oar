/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import {
  client as createClient,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { startAcpProcess, withAcpDeadline } from "../../shared/acp/process.js";
import { closeAcpSession } from "../../shared/acp/profile.js";
import { effortLevelOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { selectKimiAuthMethod } from "./session.js";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function configOption(response: JsonRecord, id: string): JsonRecord | undefined {
  return asRecordList(response.configOptions).find((option) => option.id === id);
}

/**
 * Project a `session/new` response. Kimi has no model-list method; the usable
 * list for the logged-in account rides on every new session as the
 * `configOptions` entry with id `model` (acp-server config-options.ts). A
 * `thinking` option is only emitted for the currently selected model, so
 * effort levels can only be attached to that entry; its `off` value is a
 * toggle, not an effort level, and is dropped.
 */
export function projectKimiModels(response: unknown): ModelEntry[] | undefined {
  const root = asRecord(response) ?? {};
  const modelOption = configOption(root, "model");
  if (modelOption === undefined) {
    return undefined;
  }
  const current = text(modelOption.currentValue);
  const thinking = configOption(root, "thinking");
  const effortLevels = thinking === undefined
    ? undefined
    : asRecordList(thinking.options)
        .map((option) => effortLevelOf(option.value))
        .filter((level): level is string => level !== undefined && level !== "off");
  const defaultEffort = thinking === undefined ? undefined : effortLevelOf(thinking.currentValue);
  const entries: ModelEntry[] = [];
  for (const model of asRecordList(modelOption.options)) {
    const id = text(model.value);
    if (id === undefined) {
      continue;
    }
    const displayName = text(model.name);
    const isCurrent = id === current;
    entries.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(isCurrent && effortLevels !== undefined && effortLevels.length > 0 ? { effortLevels } : {}),
      ...(isCurrent && defaultEffort !== undefined && defaultEffort !== "off" ? { defaultEffort } : {}),
    });
  }
  return entries;
}

async function readNewSession(command: string, timeoutMs: number): Promise<JsonRecord> {
  const runtime = startAcpProcess(command, ["acp"], createClient({ name: "oar" }), { env: process.env });
  try {
    const initialize = methods.agent.initialize;
    const initialized = await withAcpDeadline(
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
    const method = selectKimiAuthMethod(asRecord(initialized) ?? {});
    if (method !== undefined) {
      const authenticate = methods.agent.authenticate;
      await withAcpDeadline(
        runtime,
        authenticate,
        timeoutMs,
        (requestOptions) => runtime.connection.agent.request(
          authenticate,
          { methodId: method },
          requestOptions,
        ),
      );
    }
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
    const record = asRecord(response) ?? {};
    const sessionId = text(record.sessionId);
    if (sessionId !== undefined) {
      // Best effort: the list is already in hand and the process is killed next.
      await closeAcpSession(runtime, sessionId).catch(() => {});
    }
    return record;
  } finally {
    runtime.kill();
    await runtime.exited;
  }
}

export const kimiListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "kimi model listing requires the kimi executable" };
  }
  try {
    const response = await readNewSession(installation.command, options.timeoutMs ?? 30_000);
    const models = projectKimiModels(response);
    if (models === undefined) {
      return { kind: "unsupported", reason: "this kimi build returns no model config option on session/new" };
    }
    return { kind: "ok", models };
  } catch (error) {
    if (error instanceof RequestError) {
      if (error.code === -32_601) {
        return { kind: "unsupported", reason: "this kimi build has no session/new method" };
      }
      if (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message)) {
        return { kind: "unauthenticated", detail: error.message };
      }
    }
    throw new Error("Failed to list Kimi models", { cause: error });
  }
};
