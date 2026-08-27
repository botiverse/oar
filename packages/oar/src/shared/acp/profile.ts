import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ContextUsage, SessionOptions, TurnOutcome } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import { acpRpcError } from "./errors.js";
import type { AcpJsonRpcClient } from "./json-rpc.js";

export interface AcpSessionProfile {
  readonly args: readonly string[] | ((options: SessionOptions) => readonly string[]);
  readonly requestTimeoutMs?: number;
  readonly abortTimeoutMs?: number;
  /** Compatibility for agents that put a fully quoted shell line in `command`. */
  readonly terminalShellCommand?: boolean;
  readonly initializeMeta?: (options: SessionOptions) => JsonRecord | undefined;
  readonly sessionMeta?: (options: SessionOptions) => JsonRecord | undefined;
  readonly selectAuthMethod?: (initialized: JsonRecord) => string | undefined;
  readonly validateOptions?: (options: SessionOptions) => void;
  readonly configureSession?: (context: {
    readonly client: AcpJsonRpcClient;
    readonly sessionId: string;
    readonly response: JsonRecord;
    readonly options: SessionOptions;
  }) => Promise<void>;
  /** Return prompt-level extension fields for the runtime's native steer. */
  readonly steerParams?: (input: string) => JsonRecord;
  readonly promptContextUsage?: (response: JsonRecord) => ContextUsage | null;
  readonly promptOutcome?: (response: JsonRecord) => TurnOutcome | null;
  readonly reverseRequest?: (
    method: string,
    params: JsonRecord,
  ) => JsonRecord | Promise<JsonRecord>;
}

export interface OpenedAcpSession {
  readonly initialized: JsonRecord;
  readonly response: JsonRecord;
  readonly sessionId: string;
}

export function hasAcpCapability(value: unknown): boolean {
  return value === true || asRecord(value) !== null;
}

export function defaultAcpReverseRequest(method: string, params: JsonRecord): JsonRecord {
  if (method !== "session/request_permission") {
    throw acpRpcError(-32_601, `ACP client method not found: ${method}`);
  }
  const values = Array.isArray(params.options) ? params.options : [];
  const options = values
    .map((value) => asRecord(value))
    .filter((value): value is JsonRecord => value !== null);
  const selected = options.find((option) => option.kind === "allow_always")
    ?? options.find((option) => option.kind === "allow_once");
  return typeof selected?.optionId === "string"
    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

async function initialize(
  client: AcpJsonRpcClient,
  profile: AcpSessionProfile,
  options: SessionOptions,
): Promise<JsonRecord> {
  await client.spawned;
  const meta = profile.initializeMeta?.(options);
  const initialized = await client.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: true,
    },
    clientInfo: { name: "oar", version: "0.0.0" },
    ...(meta === undefined ? {} : { _meta: meta }),
  });
  const authMethod = profile.selectAuthMethod?.(initialized);
  if (authMethod !== undefined) {
    await client.request(methods.agent.authenticate, { methodId: authMethod });
  }
  return initialized;
}

async function createOrResume(
  client: AcpJsonRpcClient,
  initialized: JsonRecord,
  options: SessionOptions,
  meta: JsonRecord | undefined,
): Promise<{ readonly response: JsonRecord; readonly sessionId: string }> {
  const baseParams = {
    cwd: options.cwd,
    mcpServers: [],
    ...(meta === undefined ? {} : { _meta: meta }),
  };
  const capabilities = asRecord(initialized.agentCapabilities);
  const sessionCapabilities = asRecord(capabilities?.sessionCapabilities);
  if (options.resume !== undefined) {
    const sessionId = options.resume;
    const params = { ...baseParams, sessionId };
    if (hasAcpCapability(sessionCapabilities?.resume)) {
      return { response: await client.request(methods.agent.session.resume, params), sessionId };
    }
    if (capabilities?.loadSession === true) {
      return { response: await client.request(methods.agent.session.load, params), sessionId };
    }
    throw new Error("ACP runtime does not support session resume");
  }

  const response = await client.request(methods.agent.session.new, baseParams);
  const sessionId = response.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("ACP session/new returned no session id");
  }
  return { response, sessionId };
}

export async function openAcpSession(
  client: AcpJsonRpcClient,
  profile: AcpSessionProfile,
  options: SessionOptions,
): Promise<OpenedAcpSession> {
  const initialized = await initialize(client, profile, options);
  const opened = await createOrResume(
    client,
    initialized,
    options,
    profile.sessionMeta?.(options),
  );
  if (options.model !== undefined) {
    await client.request("session/set_model", {
      sessionId: opened.sessionId,
      modelId: options.model,
    });
  }
  await profile.configureSession?.({
    client,
    sessionId: opened.sessionId,
    response: opened.response,
    options,
  });
  return { initialized, ...opened };
}
