/* oxlint-disable typescript/promise-function-async -- SDK handlers deliberately return terminal promises directly. */
import {
  client as createClient,
  methods,
  type ClientApp,
  type CreateTerminalRequest,
  type JsonRpcId,
  type KillTerminalRequest,
  type ReleaseTerminalRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type WaitForTerminalExitRequest,
} from "@agentclientprotocol/sdk";
import { asRecord, type JsonRecord } from "../json.js";
import type { AcpTerminalHost } from "./terminal.js";

/**
 * What the session records about the runtime→app traffic the SDK routes to
 * this client: every request (permission, terminal) with its id and params,
 * oar's answer to it, every `session/update`, and every vendor extension
 * notification the profile subscribed to. The terminal host stays pure.
 */
export interface AcpClientHooks {
  readonly update: (notification: SessionNotification) => void;
  /** A runtime→app request arrived. */
  readonly requested: (id: string, method: string, params: unknown) => void;
  /** oar answered (or failed) a runtime→app request. */
  readonly answered: (id: string, reply: unknown) => void;
  readonly extension: (method: string, params: JsonRecord) => void;
  readonly extensionNotifications: readonly string[];
}

/** OAR's YOLO answer to a permission request: the broadest allow on offer, else cancel. */
export function allowPermission(request: RequestPermissionRequest): RequestPermissionResponse {
  const selected = request.options.find((option) => option.kind === "allow_always")
    ?? request.options.find((option) => option.kind === "allow_once");
  return selected === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: selected.optionId } };
}

let anonymousRequestCounter = 0;

function requestIdOf(context: { readonly requestId: JsonRpcId }): string {
  if (context.requestId === null) {
    anonymousRequestCounter += 1;
    return `acp-client-${String(anonymousRequestCounter)}`;
  }
  return String(context.requestId);
}

const passthrough = (params: unknown): JsonRecord => asRecord(params) ?? {};

/** Compose OAR's typed ACP client handlers directly on the official SDK app. */
export function createAcpClientApp(
  terminal: AcpTerminalHost,
  hooks: AcpClientHooks,
): ClientApp {
  // Every client request is a toApp request record; the reply (or thrown
  // error) is the answered response.
  const observed = <Params, Reply>(
    method: string,
    handle: (params: Params) => Reply | Promise<Reply>,
  ) => async (context: { readonly params: Params; readonly requestId: JsonRpcId }): Promise<Reply> => {
    const id = requestIdOf(context);
    hooks.requested(id, method, context.params);
    try {
      const reply = await handle(context.params);
      hooks.answered(id, reply);
      return reply;
    } catch (error) {
      hooks.answered(id, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  let app = createClient({ name: "oar" })
    .onRequest(methods.client.session.requestPermission, observed(methods.client.session.requestPermission, allowPermission))
    .onRequest(methods.client.terminal.create, observed(methods.client.terminal.create, (params: CreateTerminalRequest) => terminal.create(params)))
    .onRequest(methods.client.terminal.output, observed(methods.client.terminal.output, (params: TerminalOutputRequest) => terminal.output(params)))
    .onRequest(methods.client.terminal.waitForExit, observed(methods.client.terminal.waitForExit, (params: WaitForTerminalExitRequest) => terminal.waitForExit(params)))
    .onRequest(methods.client.terminal.kill, observed(methods.client.terminal.kill, (params: KillTerminalRequest) => terminal.kill(params)))
    .onRequest(methods.client.terminal.release, observed(methods.client.terminal.release, (params: ReleaseTerminalRequest) => terminal.release(params)))
    .onNotification(methods.client.session.update, ({ params }) => {
      hooks.update(params);
    });
  for (const method of hooks.extensionNotifications) {
    app = app.onNotification(method, passthrough, ({ params }) => {
      hooks.extension(method, params);
    });
  }
  return app;
}
