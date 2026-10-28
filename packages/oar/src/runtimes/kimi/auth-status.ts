import { client, methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { AuthStatus, AuthStatusOptions } from "../../contracts/login.js";
import { startAcpProcess, type AcpProcess } from "../../shared/acp/process.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { asRecord, asRecordList } from "../../shared/json.js";
import { loginBounds } from "../../shared/login.js";

export type KimiAuthQuery = "ok" | "auth_required" | "unsupported" | "timed_out" | "failed";
const SOURCE = "kimi acp authenticate";

/** Native authenticate only checks readiness; it never drives terminal-auth or creates a session. */
export async function queryKimiAuth(command: string, method: "authenticate" | "logout", options: AuthStatusOptions & { readonly signal?: AbortSignal }): Promise<KimiAuthQuery> {
  const bounds = loginBounds(options.signal, options.timeoutMs ?? 20_000);
  let runtime: AcpProcess | undefined = undefined;
  try {
    runtime = startAcpProcess(command, ["acp"], client({ name: "oar" }), {
      env: sessionEnvironment(options.env), inheritStderr: false,
      redact: () => "Kimi authentication query failed",
    });
    const process = runtime;
    const query = async (): Promise<KimiAuthQuery> => {
      try {
        await process.spawned;
        const initialized = await process.connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "oar", version: "0.0.0" },
        });
        const response = asRecord(initialized);
        if (method === "authenticate" && !asRecordList(response?.authMethods).some((entry) => entry.id === "login")) { return "unsupported"; }
        if (method === "logout" && asRecord(asRecord(response?.agentCapabilities)?.auth)?.logout === undefined) { return "unsupported"; }
        try {
          await process.connection.agent.request(method, method === "authenticate" ? { methodId: "login" } : {});
          return "ok";
        } catch (error) {
          if (error instanceof RequestError && error.code === -32_000 && method === "authenticate") { return "auth_required"; }
          if (error instanceof RequestError && error.code === -32_601) { return "unsupported"; }
          return "failed";
        }
      } catch { return "failed"; }
    };
    const timedOut = async (): Promise<KimiAuthQuery> => { await bounds.stopped; return "timed_out"; };
    return await Promise.race([query(), timedOut()]);
  } finally { bounds.dispose(); runtime?.kill(); await runtime?.exited; }
}

/** The auth gate reads cached material; the whole ACP startup is not declared local-only. */
export async function kimiAuthStatus(installation: AvailableInstallation, options: AuthStatusOptions = {}): Promise<AuthStatus> {
  if (installation.via !== "executable") { return { kind: "unknown", source: SOURCE, detail: "Kimi authentication requires an executable" }; }
  const result = await queryKimiAuth(installation.command, "authenticate", options).catch((): KimiAuthQuery => "failed");
  if (result === "ok" || result === "auth_required") { return { kind: result === "ok" ? "logged_in" : "logged_out", source: SOURCE }; }
  const detail = result === "timed_out" ? "Kimi authentication query timed out"
    : (result === "unsupported" ? "This Kimi build does not expose the authentication check"
    : "Kimi authentication query failed");
  return { kind: "unknown", source: SOURCE, detail };
}
