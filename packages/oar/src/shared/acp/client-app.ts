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
import type { AppDecision } from "../../contracts/session.js";
import type { AnswerDelivery } from "../app-requests.js";
import { asRecord, type JsonRecord } from "../json.js";
import { ACP_CANCELLED, acpPermissionReply, type AcpPermissionOptions } from "./approvals.js";
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
  /**
   * Present under `SessionOptions.approvals: "ask"`: a permission request is
   * handed here and its reply is whatever this settles to, however much
   * later (the session answers it through `Session.answer`, which records the
   * answer; `answered` is not called for it). Absent: oar's YOLO answer.
   */
  readonly askPermission?: (id: string, params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
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
  const { askPermission } = hooks;
  // Asked of a person: recorded on arrival, answered (and recorded) by whoever settles it.
  const asked = (ask: NonNullable<AcpClientHooks["askPermission"]>) =>
    async (context: { readonly params: RequestPermissionRequest; readonly requestId: JsonRpcId }): Promise<RequestPermissionResponse> => {
      const id = requestIdOf(context);
      hooks.requested(id, methods.client.session.requestPermission, context.params);
      const reply = await ask(id, context.params);
      return reply;
    };
  let app = createClient({ name: "oar" })
    .onRequest(methods.client.session.requestPermission, askPermission === undefined
      ? observed(methods.client.session.requestPermission, allowPermission)
      : asked(askPermission))
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

/**
 * Permission requests waiting for `Session.answer` (SessionOptions.approvals
 * "ask"): each holds the agent's JSON-RPC request open until answered.
 */
export interface AcpAsking {
  /** The client hook: park the request, reply with whatever settles it. */
  readonly askPermission: NonNullable<AcpClientHooks["askPermission"]>;
  /** Send the reply for `decision` to the waiting request `requestId`, or say why none. */
  deliver(requestId: string, decision: AppDecision): AnswerDelivery;
  /** Answer every waiting request `cancelled`, as ACP requires after `session/cancel`; `record` is told each answer. */
  cancelAll(record: (id: string, reply: RequestPermissionResponse) => void): void;
  /** The agent is gone: nothing can take a reply. */
  clear(): void;
}

export function createAcpAsking(options: AcpPermissionOptions = {}): AcpAsking {
  const waiting = new Map<string, { readonly params: RequestPermissionRequest; readonly reply: (response: RequestPermissionResponse) => void }>();
  return {
    async askPermission(id, params) {
      const { promise, resolve } = Promise.withResolvers<RequestPermissionResponse>();
      waiting.set(id, { params, reply: resolve });
      const response = await promise;
      return response;
    },
    deliver(requestId, decision) {
      const pending = waiting.get(requestId);
      if (pending === undefined) {
        return { kind: "rejected", code: "unsupported", reason: "oar answers this request itself (a terminal, or a permission outside approvals \"ask\")" };
      }
      const reply = acpPermissionReply(pending.params, decision, options);
      if (reply.kind === "sent") {
        waiting.delete(requestId);
        // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- acpPermissionReply builds (or checks) a RequestPermissionResponse object.
        pending.reply(reply.native as RequestPermissionResponse);
      }
      return reply;
    },
    cancelAll(record) {
      for (const [id, pending] of waiting) {
        waiting.delete(id);
        pending.reply(ACP_CANCELLED);
        record(id, ACP_CANCELLED);
      }
    },
    clear() {
      waiting.clear();
    },
  };
}
