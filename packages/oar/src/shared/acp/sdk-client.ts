import {
  client as createClient,
  methods,
  RequestError,
  type ClientApp,
  type CreateElicitationResponse,
  type CreateTerminalResponse,
  type KillTerminalResponse,
  type ReadTextFileResponse,
  type ReleaseTerminalResponse,
  type RequestPermissionResponse,
  type TerminalOutputResponse,
  type WaitForTerminalExitResponse,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { asRecord, type JsonRecord } from "../json.js";
import { AcpError } from "./errors.js";

export interface AcpSdkClientOptions {
  readonly reverseRequest?: (method: string, params: JsonRecord) => JsonRecord | Promise<JsonRecord>;
  readonly reverseRequestMethods?: readonly string[];
  readonly notificationMethods?: readonly string[];
}

const standardReverseMethods = new Set<string>([
  methods.client.session.requestPermission,
  methods.client.fs.writeTextFile,
  methods.client.fs.readTextFile,
  methods.client.terminal.create,
  methods.client.terminal.output,
  methods.client.terminal.release,
  methods.client.terminal.waitForExit,
  methods.client.terminal.kill,
  methods.client.elicitation.create,
]);

function record(value: unknown): JsonRecord {
  return asRecord(value) ?? {};
}

async function reverse<Response>(
  options: AcpSdkClientOptions,
  method: string,
  params: unknown,
): Promise<Response> {
  try {
    if (options.reverseRequest === undefined) {
      throw RequestError.methodNotFound(method);
    }
    const result = await options.reverseRequest(method, record(params));
    // The SDK validates each standard request before this dispatcher. The
    // method-specific OAR host is responsible for its matching response shape.
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Method registration fixes Response at this local protocol boundary.
    return result as Response;
  } catch (error) {
    if (error instanceof AcpError && error.kind === "rpc") {
      throw new RequestError(error.code ?? -32_603, error.message, error.data);
    }
    throw error;
  }
}

export function createAcpSdkClient(
  options: AcpSdkClientOptions,
  emitNotification: (method: string, params: JsonRecord) => void,
): ClientApp {
  const app = createClient({ name: "oar" })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      const response = await reverse<RequestPermissionResponse>(
        options,
        methods.client.session.requestPermission,
        params,
      );
      return response;
    })
    .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
      const response = await reverse<WriteTextFileResponse>(
        options,
        methods.client.fs.writeTextFile,
        params,
      );
      return response;
    })
    .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
      const response = await reverse<ReadTextFileResponse>(
        options,
        methods.client.fs.readTextFile,
        params,
      );
      return response;
    })
    .onRequest(methods.client.terminal.create, async ({ params }) => {
      const response = await reverse<CreateTerminalResponse>(
        options,
        methods.client.terminal.create,
        params,
      );
      return response;
    })
    .onRequest(methods.client.terminal.output, async ({ params }) => {
      const response = await reverse<TerminalOutputResponse>(
        options,
        methods.client.terminal.output,
        params,
      );
      return response;
    })
    .onRequest(methods.client.terminal.release, async ({ params }) => {
      const response = await reverse<ReleaseTerminalResponse>(
        options,
        methods.client.terminal.release,
        params,
      );
      return response;
    })
    .onRequest(methods.client.terminal.waitForExit, async ({ params }) => {
      const response = await reverse<WaitForTerminalExitResponse>(
        options,
        methods.client.terminal.waitForExit,
        params,
      );
      return response;
    })
    .onRequest(methods.client.terminal.kill, async ({ params }) => {
      const response = await reverse<KillTerminalResponse>(
        options,
        methods.client.terminal.kill,
        params,
      );
      return response;
    })
    .onRequest(methods.client.elicitation.create, async ({ params }) => {
      const response = await reverse<CreateElicitationResponse>(
        options,
        methods.client.elicitation.create,
        params,
      );
      return response;
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      emitNotification(methods.client.session.update, record(params));
    })
    .onNotification(methods.client.elicitation.complete, ({ params }) => {
      emitNotification(methods.client.elicitation.complete, record(params));
    });

  for (const method of new Set(options.reverseRequestMethods)) {
    if (!standardReverseMethods.has(method)) {
      app.onRequest<JsonRecord, JsonRecord>(method, record, async ({ params }) => {
        const response = await reverse<JsonRecord>(options, method, params);
        return response;
      });
    }
  }
  for (const method of new Set(options.notificationMethods)) {
    if (method !== methods.client.session.update && method !== methods.client.elicitation.complete) {
      app.onNotification<JsonRecord>(method, record, ({ params }) => {
        emitNotification(method, params);
      });
    }
  }
  return app;
}
