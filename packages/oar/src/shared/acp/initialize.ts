/* oxlint-disable typescript/promise-function-async -- SDK request callbacks return the native promise. */
import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { SessionOptions } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import type { AcpOpenObserver, AcpSessionProfile } from "./profile.js";
import { type AcpProcess, withAcpDeadline } from "./process.js";

export async function initializeAcpConnection(
  process: AcpProcess,
  profile: AcpSessionProfile,
  options: SessionOptions,
  observe: AcpOpenObserver,
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
  const response = asRecord(initialized);
  if (response === null) { throw new TypeError(`ACP ${method} returned a non-object response`); }
  observe({ method, response });
  const authMethod = profile.selectAuthMethod?.(response);
  if (authMethod !== undefined) {
    const authenticate = methods.agent.authenticate;
    const authenticated = await withAcpDeadline(
      process,
      authenticate,
      profile.requestTimeoutMs ?? 15_000,
      (requestOptions) => process.connection.agent.request(
        authenticate,
        { methodId: authMethod },
        requestOptions,
      ),
    );
    observe({ method: authenticate, response: asRecord(authenticated) ?? {} });
  }
  return response;
}
