import { client, methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { AuthStatusOptions } from "../../contracts/login.js";
import { sessionEnvironment } from "../environment.js";
import { asRecord, asRecordList } from "../json.js";
import { withQueryDeadline } from "../executable/query.js";
import { startAcpProcess, type AcpProcess } from "./process.js";

/** How an ACP auth call ended: done, a typed "sign in first", not offered by this build, or not finished. */
export type AcpAuthQuery = "ok" | "auth_required" | "unsupported" | "timed_out" | "failed";

type AuthCall = { readonly method: "authenticate"; readonly methodId: string } | { readonly method: "logout" };
export type AcpAuthOptions = AuthStatusOptions & {
  readonly signal?: AbortSignal;
  readonly args?: readonly string[];
  /** A login or logout also owns the process used to confirm its result. */
  readonly joinCleanup?: boolean;
};

async function requestAuth(process: AcpProcess, call: AuthCall, signal: AbortSignal): Promise<AcpAuthQuery> {
  await process.spawned;
  signal.throwIfAborted();
  const initialized = await process.connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "oar", version: "0.0.0" },
  });
  signal.throwIfAborted();
  const response = asRecord(initialized);
  if (call.method === "authenticate" && !asRecordList(response?.authMethods).some((entry) => entry.id === call.methodId)) { return "unsupported"; }
  if (call.method === "logout" && asRecord(asRecord(response?.agentCapabilities)?.auth)?.logout === undefined) { return "unsupported"; }
  try {
    await process.connection.agent.request(call.method, call.method === "authenticate" ? { methodId: call.methodId } : {});
    return "ok";
  } catch (error) {
    if (error instanceof RequestError && error.code === -32_000 && call.method === "authenticate") { return "auth_required"; }
    if (error instanceof RequestError && error.code === -32_601) { return "unsupported"; }
    return "failed";
  }
}

/**
 * One ACP auth call on a fresh `<command> acp` process, killed afterwards:
 * `authenticate {methodId}` (a readiness check where the runtime answers it
 * from cached material; never terminal auth, never a session) or `logout`
 * (only when `initialize` declares `agentCapabilities.auth.logout`).
 * `name` labels the redacted failure.
 */
export async function queryAcpAuth(command: string, call: AuthCall, name: string, options: AcpAuthOptions): Promise<AcpAuthQuery> {
  let cleanup: Promise<unknown> = Promise.resolve();
  try {
    return await withQueryDeadline<AcpAuthQuery>(name, options.timeoutMs ?? 20_000, async (signal, own) => {
      try {
        const runtime = own(startAcpProcess(command, options.args ?? ["acp"], client({ name: "oar" }), {
          env: sessionEnvironment(options.env), inheritStderr: false,
          redact: () => `${name} authentication query failed`,
        }));
        cleanup = runtime.exited;
        return await requestAuth(runtime, call, signal);
      } catch { return "failed"; }
    }, "timed_out", options.signal);
  } finally {
    if (call.method === "logout" || options.joinCleanup === true) { await cleanup; }
  }
}
