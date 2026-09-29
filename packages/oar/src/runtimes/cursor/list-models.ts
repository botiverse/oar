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
import { cursorAcpArgs, cursorClientCapabilitiesMeta, selectCursorAuthMethod } from "./session.js";

const listMethod = "cursor/list_available_models";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Project the `cursor/list_available_models` answer (cursor-agent
 * 2026.09.28): `{models: [{value, name, configOptions}]}`, where `value` is
 * the model name `session/set_config_option` accepts for `model`, `name` the
 * display name, and `configOptions` the model's parameters as select options
 * at their default values. The reasoning parameter is the one under category
 * `thought_level`, the same option a session offers for that model.
 */
export function projectCursorModels(result: unknown): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const model of asRecordList(asRecord(result)?.models)) {
    const id = text(model.value);
    if (id === undefined) {
      continue;
    }
    const displayName = text(model.name);
    const thoughtLevel = asRecordList(model.configOptions).find((option) => option.category === "thought_level");
    const effortLevels = thoughtLevel === undefined
      ? undefined
      : asRecordList(thoughtLevel.options).flatMap((option) => text(option.value) ?? []);
    const defaultEffort = thoughtLevel === undefined ? undefined : text(thoughtLevel.currentValue);
    entries.push({
      id,
      ...(displayName === undefined || displayName === id ? {} : { displayName }),
      ...(effortLevels === undefined || effortLevels.length === 0 ? {} : { effortLevels }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    });
  }
  return entries;
}

async function readModels(command: string, timeoutMs: number): Promise<JsonRecord> {
  const runtime = startAcpProcess(command, cursorAcpArgs, createClient({ name: "oar" }), { env: process.env });
  try {
    const initialize = methods.agent.initialize;
    const response = await withAcpDeadline(
      runtime,
      initialize,
      timeoutMs,
      (requestOptions) => runtime.connection.agent.request(initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: cursorClientCapabilitiesMeta(),
        },
        clientInfo: { name: "oar", version: "0.0.0" },
      }, requestOptions),
    );
    const method = selectCursorAuthMethod(asRecord(response) ?? {});
    if (method !== undefined) {
      const authenticate = methods.agent.authenticate;
      await withAcpDeadline(
        runtime,
        authenticate,
        timeoutMs,
        (requestOptions) => runtime.connection.agent.request(authenticate, { methodId: method }, requestOptions),
      );
    }
    return await withAcpDeadline(
      runtime,
      listMethod,
      timeoutMs,
      (requestOptions) => runtime.connection.agent.request<JsonRecord>(listMethod, {}, requestOptions),
    );
  } finally {
    runtime.kill();
    await runtime.exited;
  }
}

export const cursorListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "cursor model listing requires the cursor-agent executable" };
  }
  try {
    const result = await readModels(installation.command, options.timeoutMs ?? 15_000);
    return { kind: "ok", models: projectCursorModels(result) };
  } catch (error) {
    if (error instanceof RequestError) {
      if (error.code === -32_601) {
        return { kind: "unsupported", reason: `this cursor-agent build has no ${listMethod} method` };
      }
      // cursor-agent answers `authRequired` (-32000) until `cursor-agent login` has run.
      if (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message)) {
        return { kind: "unauthenticated", detail: error.message };
      }
    }
    throw new Error("Failed to list Cursor models", { cause: error });
  }
};
