/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import {
  methods,
  PROTOCOL_VERSION,
  type ClientConnection,
  type SendRequestOptions,
} from "@agentclientprotocol/sdk";
import type { ContextUsage, SessionOptions, TurnOutcome } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import { type AcpProcess, withAcpDeadline } from "./process.js";

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
    readonly connection: ClientConnection;
    readonly sessionId: string;
    readonly response: JsonRecord;
    readonly options: SessionOptions;
    readonly requestOptions?: SendRequestOptions;
  }) => Promise<void>;
  /** Return prompt-level extension fields for the runtime's native steer. */
  readonly steerParams?: (input: string) => JsonRecord;
  readonly promptContextUsage?: (response: JsonRecord) => ContextUsage | null;
  readonly promptOutcome?: (response: JsonRecord) => TurnOutcome | null;
}

export interface OpenedAcpSession {
  readonly initialized: JsonRecord;
  readonly response: JsonRecord;
  readonly sessionId: string;
}

export function hasAcpCapability(value: unknown): boolean {
  return value === true || asRecord(value) !== null;
}

function responseRecord(method: string, value: unknown): JsonRecord {
  const response = asRecord(value);
  if (response === null) {
    throw new TypeError(`ACP ${method} returned a non-object response`);
  }
  return response;
}

export async function promptAcp(
  process: AcpProcess,
  sessionId: string,
  input: string,
  extraParams: JsonRecord = {},
): Promise<JsonRecord> {
  const method = methods.agent.session.prompt;
  const response = await withAcpDeadline(
    process,
    method,
    null,
    (requestOptions) => process.connection.agent.request(method, {
      sessionId,
      prompt: [{ type: "text", text: input }],
      ...extraParams,
    }, requestOptions),
  );
  // The SDK's built-in session router yields once before OAR's update handler.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  return responseRecord(method, response);
}

export async function closeAcpSession(process: AcpProcess, sessionId: string): Promise<void> {
  const method = methods.agent.session.close;
  await withAcpDeadline(
    process,
    method,
    2000,
    (requestOptions) => process.connection.agent.request(
      method,
      { sessionId },
      requestOptions,
    ),
  );
}

async function initialize(
  process: AcpProcess,
  profile: AcpSessionProfile,
  options: SessionOptions,
): Promise<JsonRecord> {
  const meta = profile.initializeMeta?.(options);
  const method = methods.agent.initialize;
  const initialized = await withAcpDeadline(
    process,
    method,
    profile.requestTimeoutMs ?? 15_000,
    (requestOptions) => process.connection.agent.request(method, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      },
      clientInfo: { name: "oar", version: "0.0.0" },
      ...(meta === undefined ? {} : { _meta: meta }),
    }, requestOptions),
  );
  const response = responseRecord(method, initialized);
  const authMethod = profile.selectAuthMethod?.(response);
  if (authMethod !== undefined) {
    const authenticate = methods.agent.authenticate;
    await withAcpDeadline(
      process,
      authenticate,
      profile.requestTimeoutMs ?? 15_000,
      (requestOptions) => process.connection.agent.request(
        authenticate,
        { methodId: authMethod },
        requestOptions,
      ),
    );
  }
  return response;
}

async function createOrResume(
  process: AcpProcess,
  profile: AcpSessionProfile,
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
  const timeoutMs = profile.requestTimeoutMs ?? 15_000;
  if (options.resume !== undefined) {
    const sessionId = options.resume;
    const params = { ...baseParams, sessionId };
    let method: typeof methods.agent.session.resume | typeof methods.agent.session.load | undefined =
      undefined;
    if (hasAcpCapability(sessionCapabilities?.resume)) {
      method = methods.agent.session.resume;
    } else if (capabilities?.loadSession === true) {
      method = methods.agent.session.load;
    }
    if (method === undefined) {
      throw new Error("ACP runtime does not support session resume");
    }
    const resumed = await withAcpDeadline(
      process,
      method,
      timeoutMs,
      (requestOptions) => process.connection.agent.request(method, params, requestOptions),
    );
    return { response: responseRecord(method, resumed), sessionId };
  }

  const method = methods.agent.session.new;
  const created = await withAcpDeadline(
    process,
    method,
    timeoutMs,
    (requestOptions) => process.connection.agent.request(method, baseParams, requestOptions),
  );
  const response = responseRecord(method, created);
  const sessionId = response.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("ACP session/new returned no session id");
  }
  return { response, sessionId };
}

export async function openAcpSession(
  process: AcpProcess,
  profile: AcpSessionProfile,
  options: SessionOptions,
): Promise<OpenedAcpSession> {
  const initialized = await initialize(process, profile, options);
  const opened = await createOrResume(
    process,
    profile,
    initialized,
    options,
    profile.sessionMeta?.(options),
  );
  if (options.model !== undefined) {
    await withAcpDeadline(
      process,
      "session/set_model",
      profile.requestTimeoutMs ?? 15_000,
      (requestOptions) => process.connection.agent.request(
        "session/set_model",
        { sessionId: opened.sessionId, modelId: options.model },
        requestOptions,
      ),
    );
  }
  const configure = profile.configureSession;
  if (configure !== undefined) {
    await withAcpDeadline(
      process,
      "session/configure",
      profile.requestTimeoutMs ?? 15_000,
      (requestOptions) => configure({
        connection: process.connection,
        sessionId: opened.sessionId,
        response: opened.response,
        options,
        ...(requestOptions === undefined ? {} : { requestOptions }),
      }),
    );
  }
  return { initialized, ...opened };
}
