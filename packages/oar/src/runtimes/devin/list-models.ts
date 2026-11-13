/* oxlint-disable import/max-dependencies, typescript/promise-function-async -- Model listing wires ACP session probing, shared deadlines and auth status fallback; deadline callbacks return native SDK promises. */
import {
  client as createClient,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { acpThoughtLevelOption } from "../../shared/acp/model.js";
import { startAcpProcess, withAcpDeadline } from "../../shared/acp/process.js";
import { hasAcpCapability } from "../../shared/acp/profile.js";
import { remainingMs } from "../../shared/deadline.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { listingCwd } from "../../shared/listing-cwd.js";
import { readDevinAuthStatus } from "./auth.js";
import { devinAcpArgs } from "./session.js";

const LISTING = "Devin model listing";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Project a `session/new` response's `model` and `thought_level` config options into model catalog entries. */
export function projectDevinModels(response: unknown): ModelEntry[] | undefined {
  const root = asRecord(response);
  const modelOption = asRecordList(root?.configOptions).find((option) => option.id === "model");
  if (modelOption === undefined) {
    return undefined;
  }
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
      ...(id === current && defaultEffort !== undefined ? { defaultEffort } : {}),
    });
  }
  return entries;
}

async function readNewSession(
  command: string,
  cwd: string,
  deadline: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<JsonRecord> {
  const runtime = startAcpProcess(command, devinAcpArgs(), createClient({ name: "oar" }), { cwd, env });
  const stop = (): void => { runtime.kill(); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) {
    stop();
  }
  try {
    const initialize = methods.agent.initialize;
    const initialized = asRecord(await withAcpDeadline(
      runtime,
      initialize,
      remainingMs(deadline, LISTING),
      (requestOptions) => runtime.connection.agent.request(initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "oar", version: "0.0.0" },
      }, requestOptions),
    ));
    signal.throwIfAborted();
    const newSession = methods.agent.session.new;
    const response = await withAcpDeadline(
      runtime,
      newSession,
      remainingMs(deadline, LISTING),
      (requestOptions) => runtime.connection.agent.request<JsonRecord>(
        newSession,
        { cwd, mcpServers: [] },
        requestOptions,
      ),
    );
    signal.throwIfAborted();
    const capabilities = asRecord(asRecord(initialized?.agentCapabilities)?.sessionCapabilities);
    const cleanupMethod = hasAcpCapability(capabilities?.delete)
      ? methods.agent.session.delete
      : (hasAcpCapability(capabilities?.close) ? methods.agent.session.close : undefined);
    const cleanupMs = Math.min(2000, Math.max(0, deadline - Date.now()));
    if (typeof response.sessionId === "string" && cleanupMethod !== undefined && cleanupMs > 0) {
      await withAcpDeadline(
        runtime,
        cleanupMethod,
        cleanupMs,
        (requestOptions) => runtime.connection.agent.request(cleanupMethod, { sessionId: response.sessionId }, requestOptions),
      ).catch(() => {});
    }
    return asRecord(response) ?? {};
  } finally {
    signal.removeEventListener("abort", stop);
    runtime.kill();
    if (!signal.aborted) {
      await runtime.exited;
    }
  }
}

export const devinListModels: ModelLister = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "devin model listing requires the devin CLI executable" };
  }
  try {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    return await withQueryDeadline(LISTING, timeoutMs, async (signal) => {
      const response = await readNewSession(
        installation.command,
        listingCwd(options),
        deadline,
        signal,
        sessionEnvironment(options.env),
      );
      const models = projectDevinModels(response);
      if (models === undefined) {
        return { kind: "unsupported", reason: "this devin CLI build returns no model config option on session/new" };
      }
      if (models.length === 0) {
        const status = await readDevinAuthStatus(installation, {
          ...(options.env === undefined ? {} : { env: options.env }),
          timeoutMs: remainingMs(deadline, LISTING),
          signal,
        });
        if (status.kind === "logged_out") {
          return { kind: "unauthenticated", detail: status.detail ?? "Not logged in. Run `devin auth login` to authenticate." };
        }
        if (status.kind === "unknown") {
          if (status.configured !== undefined) {
            return {
              kind: "unsupported",
              reason: status.detail ?? "Devin returned an empty model catalog while authentication status is unknown",
            };
          }
          throw new Error(status.detail ?? "Failed to verify Devin authentication for empty model catalog");
        }
      }
      return { kind: "ok", models };
    });
  } catch (error) {
    if (error instanceof RequestError && (error.code === -32_000 || /auth(?:entication)?|not logged in|invalid api key/iu.test(error.message))) {
      return { kind: "unauthenticated", detail: error.message };
    }
    throw new Error(
      error instanceof Error ? `Failed to list Devin models: ${error.message}` : "Failed to list Devin models",
      { cause: error },
    );
  }
};
