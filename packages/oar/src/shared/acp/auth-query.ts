import { client, methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { AuthStatusOptions } from "../../contracts/login.js";
import { sessionEnvironment } from "../environment.js";
import { asRecord, asRecordList } from "../json.js";
import { loginBounds } from "../login.js";
import { startAcpProcess, type AcpProcess } from "./process.js";

/** How an ACP auth call ended: done, a typed "sign in first", not offered by this build, or not finished. */
export type AcpAuthQuery = "ok" | "auth_required" | "unsupported" | "timed_out" | "failed";

/**
 * One ACP auth call on a fresh `<command> acp` process, killed afterwards:
 * `authenticate {methodId}` (a readiness check where the runtime answers it
 * from cached material; never terminal auth, never a session) or `logout`
 * (only when `initialize` declares `agentCapabilities.auth.logout`).
 * `name` labels the redacted failure.
 */
export async function queryAcpAuth(
  command: string,
  call: { readonly method: "authenticate"; readonly methodId: string } | { readonly method: "logout" },
  name: string,
  options: AuthStatusOptions & { readonly signal?: AbortSignal },
): Promise<AcpAuthQuery> {
  const bounds = loginBounds(options.signal, options.timeoutMs ?? 20_000);
  let runtime: AcpProcess | undefined = undefined;
  try {
    runtime = startAcpProcess(command, ["acp"], client({ name: "oar" }), {
      env: sessionEnvironment(options.env), inheritStderr: false,
      redact: () => `${name} authentication query failed`,
    });
    const process = runtime;
    const query = async (): Promise<AcpAuthQuery> => {
      try {
        await process.spawned;
        options.signal?.throwIfAborted();
        const initialized = await process.connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "oar", version: "0.0.0" },
        });
        options.signal?.throwIfAborted();
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
      } catch { return "failed"; }
    };
    const timedOut = async (): Promise<AcpAuthQuery> => { await bounds.stopped; return "timed_out"; };
    return await Promise.race([query(), timedOut()]);
  } finally { bounds.dispose(); runtime?.kill(); await runtime?.exited; }
}
