/* oxlint-disable typescript/promise-function-async -- Request callbacks return the ACP SDK promise directly. */
import { client as createClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { startAcpProcess, withAcpDeadline, type AcpProcess } from "../../shared/acp/process.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { grokInitializeMeta } from "./session.js";

/** Extract identity only from Grok's native `_x.ai/auth/info` result. */
export function grokAccountEmail(result: unknown): string | undefined {
  const email = asRecord(result)?.email;
  if (typeof email !== "string") {
    return undefined;
  }
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function signedOutEmail(info: JsonRecord | null): string | undefined {
  const method = info?.methodId;
  return method === null || method === undefined ? grokAccountEmail(info) : undefined;
}

export function startGrokReader(command: string, env: NodeJS.ProcessEnv): AcpProcess {
  return startAcpProcess(command, ["agent", "--always-approve", "--no-leader", "stdio"], createClient({ name: "oar" }), { env });
}

export async function initializeGrokReader(runtime: AcpProcess, timeoutMs: number): Promise<JsonRecord> {
  const method = methods.agent.initialize;
  const response = await withAcpDeadline(runtime, method, timeoutMs, options => runtime.connection.agent.request(method, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "oar", version: "0.0.0" },
    _meta: grokInitializeMeta({ cwd: process.cwd() }),
  }, options));
  return asRecord(response) ?? {};
}

export async function readGrokAccountInfo(runtime: AcpProcess, timeoutMs: number): Promise<JsonRecord | null> {
  const method = "_x.ai/auth/info";
  try {
    return await withAcpDeadline(runtime, method, timeoutMs, options => runtime.connection.agent.request<JsonRecord>(method, {}, options));
  } catch { return null; }
}

/** Read only the identity Grok still reports without an active sign-in. Never request authentication here. */
export async function previousGrokEmail(command: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  if (timeoutMs <= 0) { return null; }
  try {
    return await withQueryDeadline<string | null>("Grok previous account", timeoutMs, async (signal, own) => {
      const runtime = own(startGrokReader(command, env));
      await initializeGrokReader(runtime, timeoutMs);
      signal.throwIfAborted();
      const info = await readGrokAccountInfo(runtime, timeoutMs);
      return signedOutEmail(info) ?? null;
    }, null);
  } catch { return null; }
}
