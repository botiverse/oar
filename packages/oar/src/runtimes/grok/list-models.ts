/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import {
  client as createClient,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { startAcpProcess, withAcpDeadline } from "../../shared/acp/process.js";
import { effortLevelOf, effortLevelsOf } from "../../shared/effort-levels.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { grokInitializeMeta, selectGrokAuthMethod } from "./session.js";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Unwrap the `_x.ai/models/list` result. The JSON-RPC result carries a second
 * envelope, `{result: SessionModelState}` or `{error}`; a handler error wins
 * over any result, matching grok's own client.
 */
export function grokModelState(result: unknown): JsonRecord {
  const envelope = asRecord(result) ?? {};
  if (envelope.error !== undefined) {
    const detail = text(asRecord(envelope.error)?.message) ?? text(envelope.error) ?? JSON.stringify(envelope.error);
    throw new Error(`grok models/list handler error: ${detail}`);
  }
  return asRecord(envelope.result) ?? envelope;
}

/**
 * Project a `SessionModelState`. Grok already filters to what the current
 * auth can use; entries still flagged `hidden` or not `user_selectable` are
 * dropped here as well. Both camel- and snake-case field spellings are read
 * because the extension's Rust serialization has changed between releases.
 */
export function projectGrokModels(state: unknown): ModelEntry[] {
  const root = asRecord(state) ?? {};
  const models = asRecordList(root.availableModels ?? root.available_models);
  const entries: ModelEntry[] = [];
  for (const model of models) {
    const id = text(model.modelId ?? model.model_id ?? model.id);
    if (id === undefined) {
      continue;
    }
    if (model.hidden === true || model.user_selectable === false || model.userSelectable === false) {
      continue;
    }
    const displayName = text(model.displayName ?? model.display_name ?? model.name);
    const effortLevels = effortLevelsOf(model.reasoningEfforts ?? model.reasoning_efforts);
    const defaultEffort = effortLevelOf(
      model.defaultReasoningEffort ?? model.default_reasoning_effort ?? model.reasoningEffort ?? model.reasoning_effort,
    );
    entries.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      ...(effortLevels === undefined ? {} : { effortLevels }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    });
  }
  return entries;
}

async function readModelState(command: string, timeoutMs: number): Promise<JsonRecord> {
  const runtime = startAcpProcess(
    command,
    ["agent", "--always-approve", "--no-leader", "stdio"],
    createClient({ name: "oar" }),
    { env: process.env },
  );
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
        },
        clientInfo: { name: "oar", version: "0.0.0" },
        _meta: grokInitializeMeta({ cwd: process.cwd() }),
      }, requestOptions),
    );
    const method = selectGrokAuthMethod(asRecord(response) ?? {});
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
    const result = await withAcpDeadline(
      runtime,
      "_x.ai/models/list",
      timeoutMs,
      (requestOptions) => runtime.connection.agent.request<JsonRecord>(
        "_x.ai/models/list",
        {},
        requestOptions,
      ),
    );
    return grokModelState(result);
  } finally {
    runtime.kill();
    await runtime.exited;
  }
}

export const grokListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "grok model listing requires the grok executable" };
  }
  try {
    const state = await readModelState(installation.command, options.timeoutMs ?? 10_000);
    return { kind: "ok", models: projectGrokModels(state) };
  } catch (error) {
    if (error instanceof RequestError) {
      if (error.code === -32_601) {
        return { kind: "unsupported", reason: "this grok build has no _x.ai/models/list method" };
      }
      if (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message)) {
        return { kind: "unauthenticated", detail: error.message };
      }
    }
    throw new Error("Failed to list Grok models", { cause: error });
  }
};
