/* oxlint-disable typescript/promise-function-async -- Deadline callbacks forward the official SDK promises. */
import { RequestError, type AnyMessage } from "@agentclientprotocol/sdk";
import { resolve } from "node:path";
import type { ExecutableInstallation } from "../../contracts/installation.js";
import { AcpError } from "../../shared/acp/errors.js";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../shared/acp/process.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { redactText } from "../../shared/redact-text.js";
import {
  QwenProviderAuthError,
  type QwenProvider, type QwenProviderAuth, type QwenProviderAuthOptions,
  type QwenProviderConnectResult,
} from "./provider-auth.js";

const LIST = "qwen/providers/list";
const CONNECT = "qwen/providers/connect";

/** No sessions or host callbacks: consume only response envelopes, never log other native output. */
function providerResponse(value: unknown, pending: Set<string | number>, redact: (text: string) => string): AnyMessage | undefined {
  const row = asRecord(value);
  if (row === null || row.jsonrpc !== "2.0" || "method" in row || (typeof row.id !== "number" && typeof row.id !== "string") || !pending.has(row.id)) { return undefined; }
  const { id } = row;
  const error = asRecord(row.error);
  if (error !== null) {
    if (typeof error.code !== "number") { return undefined; }
    pending.delete(id);
    return { jsonrpc: "2.0", id, error: { code: error.code, message: "Qwen provider request failed" } };
  }
  if (!("result" in row)) { return undefined; }
  pending.delete(id);
  return { jsonrpc: "2.0", id, result: redactText(row.result, redact, (text) => redact(text) !== text) };
}

function provider(value: unknown): QwenProvider {
  const row = asRecord(value);
  if (row === null || typeof row.id !== "string" || typeof row.label !== "string" || typeof row.protocol !== "string") {
    throw new QwenProviderAuthError("invalid_response", LIST);
  }
  const existingConfig = asRecord(row.existingConfig);
  if (row.existingConfig !== undefined && existingConfig === null) {
    throw new QwenProviderAuthError("invalid_response", LIST);
  }
  return { ...row, id: row.id, label: row.label, protocol: row.protocol,
    ...(existingConfig === null ? {} : { existingConfig }) };
}

function connected(value: unknown): QwenProviderConnectResult {
  const row = asRecord(value);
  if (row?.success !== true || typeof row.providerId !== "string" || typeof row.providerLabel !== "string" || typeof row.authType !== "string"
    || (row.modelId !== undefined && typeof row.modelId !== "string") || (row.baseUrl !== undefined && typeof row.baseUrl !== "string")) {
    throw new QwenProviderAuthError("invalid_response", CONNECT);
  }
  return { success: true, providerId: row.providerId, providerLabel: row.providerLabel, authType: row.authType,
    ...(row.modelId === undefined ? {} : { modelId: row.modelId }), ...(row.baseUrl === undefined ? {} : { baseUrl: row.baseUrl }) };
}

function failure(error: unknown, method: string): QwenProviderAuthError {
  if (error instanceof QwenProviderAuthError) { return error; }
  if (error instanceof RequestError) { return new QwenProviderAuthError("native", method, error.code); }
  if (error instanceof AcpError) { return new QwenProviderAuthError(error.kind, method); }
  return new QwenProviderAuthError("launch_failed", method);
}

export function qwenProviderAuth(installation: ExecutableInstallation, options: QwenProviderAuthOptions): QwenProviderAuth {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new RangeError("Qwen provider timeoutMs must be positive and finite"); }
  const command = installation.command;
  const cwd = resolve(options.cwd ?? process.cwd());
  const overlay = { ...options.env };
  const secrets = new Set<string>();
  const redact = (text: string): string => [...secrets].toSorted((a, b) => b.length - a.length).reduce((result, key) => result.replaceAll(key, "[redacted]"), text);

  const request = async (method: string, params: JsonRecord): Promise<unknown> => {
    const until = Date.now() + timeoutMs;
    const pending = new Set<string | number>();
    let child: ReturnType<typeof startAcpProcess> | undefined = undefined;
    try {
      const opened = startAcpProcess(command, ["--acp"], createAcpClient({ name: "oar-qwen-provider-auth" }), {
        cwd, env: sessionEnvironment(overlay), redact, inheritStderr: false,
        incoming: (message) => providerResponse(message, pending, redact),
        outgoing: (message) => { if ("id" in message && "method" in message && message.id !== null) { pending.add(message.id); } },
      });
      child = opened;
      await withAcpDeadline(opened, "initialize", Math.max(1, until - Date.now()), (sendOptions) => opened.connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, sendOptions));
      if (Date.now() >= until) { throw new QwenProviderAuthError("timeout", method); }
      const result = await withAcpDeadline(opened, method, until - Date.now(), (sendOptions) => opened.connection.agent.request(method, params, sendOptions));
      return redactText(result, redact, (text) => [...secrets].some((key) => text.includes(key)));
    } catch (error) { throw failure(error, method); }
    finally { if (child !== undefined) { child.kill(); await child.exited; } }
  };

  return {
    async listProviders() {
      const result = asRecord(await request(LIST, {}));
      if (!Array.isArray(result?.providers)) { throw new QwenProviderAuthError("invalid_response", LIST); }
      return result.providers.map(provider);
    },
    async connect(params) {
      if (typeof params.apiKey === "string" && params.apiKey.length > 0) {
        secrets.add(params.apiKey);
        if (params.apiKey.trim().length > 0) { secrets.add(params.apiKey.trim()); }
      }
      // Only declared native fields; no extra runtime options or launch arguments.
      const input: JsonRecord = { providerId: params.providerId };
      for (const key of ["apiKey", "baseUrl", "protocol", "wireApi", "modelIds", "scope"] as const) {
        if (params[key] !== undefined) { input[key] = params[key]; }
      }
      return connected(await request(CONNECT, input));
    },
  };
}
