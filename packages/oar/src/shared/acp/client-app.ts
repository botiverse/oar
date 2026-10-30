/* oxlint-disable typescript/promise-function-async -- SDK handlers deliberately return terminal promises directly. */
import {
  client as createClient,
  methods,
  RequestError,
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
import type { JsonRecord } from "../json.js";
import type { AcpTerminalHost } from "./terminal.js";

/**
 * What the session records about the runtime→app traffic the SDK routes to
 * this client: every request (permission, terminal) with its id and params,
 * oar's answer to it, every `session/update`, and every vendor extension
 * notification the profile subscribed to. The terminal host stays pure.
 */
export interface AcpClientHooks {
  readonly update: (notification: SessionNotification, receivedAt?: number) => void;
  /** A runtime→app request arrived. */
  readonly requested: (id: string, method: string, params: unknown, receivedAt?: number) => void;
  /** oar answered (or failed) a runtime→app request. */
  readonly answered: (id: string, reply: unknown) => void;
  readonly extension: (method: string, params: JsonRecord, receivedAt?: number, afterOpen?: boolean) => void;
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

// Keep the decoded object's identity so its wire arrival phase survives the
// SDK's asynchronous handler chain. Redaction still runs before recording.
function isParamsRecord(params: unknown): params is JsonRecord {
  return params !== null && typeof params === "object" && !Array.isArray(params);
}
const passthrough = (params: unknown): JsonRecord => isParamsRecord(params) ? params : {};

// The SDK's built-in session router has already validated this notification.
// Its second schema parse would clone params and lose private wire metadata.
function originalNotification(params: unknown): SessionNotification {
  if (!isParamsRecord(params) || typeof params.sessionId !== "string" || !isParamsRecord(params.update)) {
    throw new TypeError("Invalid ACP session notification");
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- SDK SessionUpdateRouter validated the complete schema before this handler.
  return params as SessionNotification;
}

/** Compose OAR's typed ACP client handlers directly on the official SDK app. */
export function createAcpClientApp(
  terminal: AcpTerminalHost,
  hooks: AcpClientHooks,
): ClientApp {
  return createRoutedAcpClientApp({
    target: () => Promise.resolve({ terminal, hooks }),
    update: hooks.update,
    extension: hooks.extension,
    extensionNotifications: hooks.extensionNotifications,
  });
}

export interface AcpClientTarget { readonly terminal: AcpTerminalHost; readonly hooks: AcpClientHooks; readonly receivedAt?: number; readonly active?: () => boolean }

/** Shared and isolated connections use the same permission and terminal handlers. */
export function createRoutedAcpClientApp(routing: {
  readonly target: (method: string, params: unknown, requestId: JsonRpcId) => Promise<AcpClientTarget>;
  readonly update: AcpClientHooks["update"];
  readonly extension: AcpClientHooks["extension"];
  readonly extensionNotifications: readonly string[];
}): ClientApp {
  // Every client request is a toApp request record; the reply (or thrown
  // error) is the answered response.
  const observed = <Params, Reply>(
    method: string,
    handle: (params: Params, terminal: AcpTerminalHost) => Reply | Promise<Reply>,
  ) => async (context: { readonly params: Params; readonly requestId: JsonRpcId; readonly signal: AbortSignal }): Promise<Reply> => {
    const id = requestIdOf(context);
    const { terminal, hooks, receivedAt, active } = await routing.target(method, context.params, context.requestId);
    context.signal.throwIfAborted();
    if (active?.() === false) { throw RequestError.invalidParams(undefined, "ACP native session no longer accepts host requests"); }
    hooks.requested(id, method, context.params, receivedAt);
    try {
      const reply = await handle(context.params, terminal);
      hooks.answered(id, reply);
      return reply;
    } catch (error) {
      hooks.answered(id, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  let app = createClient({ name: "oar" })
    .onRequest(methods.client.session.requestPermission, observed(methods.client.session.requestPermission, allowPermission))
    .onRequest(methods.client.terminal.create, observed(methods.client.terminal.create, (params: CreateTerminalRequest, terminal) => terminal.create(params)))
    .onRequest(methods.client.terminal.output, observed(methods.client.terminal.output, (params: TerminalOutputRequest, terminal) => terminal.output(params)))
    .onRequest(methods.client.terminal.waitForExit, observed(methods.client.terminal.waitForExit, (params: WaitForTerminalExitRequest, terminal) => terminal.waitForExit(params)))
    .onRequest(methods.client.terminal.kill, observed(methods.client.terminal.kill, (params: KillTerminalRequest, terminal) => terminal.kill(params)))
    .onRequest(methods.client.terminal.release, observed(methods.client.terminal.release, (params: ReleaseTerminalRequest, terminal) => terminal.release(params)))
    .onNotification(methods.client.session.update, originalNotification, ({ params }) => {
      routing.update(params);
    });
  for (const method of routing.extensionNotifications) {
    app = app.onNotification(method, passthrough, ({ params }) => {
      routing.extension(method, params);
    });
  }
  return app;
}
