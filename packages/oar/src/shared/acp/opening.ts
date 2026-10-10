/* oxlint-disable typescript/promise-function-async -- Stream callbacks forward the original writer promises. */
import { methods, type AnyMessage, type JsonRpcId, type Stream } from "@agentclientprotocol/sdk";

export interface AcpOpening {
  outgoing(message: AnyMessage): void;
  incoming(message: AnyMessage): void;
  afterOpen(params: object): boolean;
}

/** Preserve the wire's opening boundary across the SDK's asynchronous notification routing. */
export function createAcpOpening(): AcpOpening {
  const requests = new Set<JsonRpcId>();
  const live = new WeakSet<object>();
  let opened = false;
  return {
    outgoing(message: AnyMessage): void {
      if ("id" in message && "method" in message
        && (message.method === methods.agent.session.new || message.method === methods.agent.session.resume || message.method === methods.agent.session.load)) {
        requests.add(message.id);
      }
    },
    incoming(message: AnyMessage): void {
      if ("id" in message && !("method" in message) && requests.delete(message.id) && "result" in message) { opened = true; }
      if (!("id" in message) && "method" in message && opened) {
        const { params } = message;
        if (params !== null && typeof params === "object") { live.add(params); }
      }
    },
    afterOpen(params: object): boolean { return live.has(params); },
  };
}

/** Observe decoded messages without changing them or delaying dispatch. */
export function observeAcpOpening(stream: Stream, opening: AcpOpening): Stream {
  const writer = stream.writable.getWriter();
  return {
    readable: stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        opening.incoming(message);
        controller.enqueue(message);
      },
    })),
    writable: new WritableStream<AnyMessage>({
      write(message) { opening.outgoing(message); return writer.write(message); },
      close() { return writer.close(); },
      abort(reason: unknown) { return writer.abort(reason); },
    }),
  };
}
