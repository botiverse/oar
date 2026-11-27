import { reportedStderr, reportedProcessFailure } from "../../../shared/executable/reported-stderr.js";
import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { LineProcess } from "../../../shared/executable/index.js";
import { asRecord, parseJson } from "../../../shared/json.js";

/** The session state a `get_state` answer carries; any other reply is not one. */
export function piRpcState(response: RpcResponse): RpcSessionState {
  if (!response.success) { throw new Error(response.error); }
  if (response.command !== "get_state") { throw new Error("Pi replied to a different command"); }
  return response.data;
}

/** Native Pi JSONL correlation. Event observers never wait for a command response. */
export function piRpcControl(child: LineProcess, receive: (message: Record<string, unknown>) => void, redact?: (text: string) => string): {
  request(command: RpcCommand, issued?: (id: string) => void): Promise<RpcResponse>;
} {
  const stderr = (): string => reportedStderr(child.diagnostics(), redact);
  let sequence = 0;
  let ended = false;
  const pending = new Map<string, { resolve(value: RpcResponse): void; reject(error: Error): void; timer: NodeJS.Timeout | undefined }>();
  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) { return; }
    receive(message);
    if (message.type !== "response" || typeof message.id !== "string") { return; }
    const waiter = pending.get(message.id);
    if (waiter === undefined) { return; }
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    // This is the bundled version's own protocol, not an arbitrary remote server.
    // SAFETY: the pinned bundled RPC encoder emits exactly this union, and the
    // id matched a pending request, so the shape is the dependency's own reply.
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- The pinned bundled RPC encoder owns this response union.
    waiter.resolve(message as unknown as RpcResponse);
  });
  child.onExit(() => {
    ended = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(reportedProcessFailure("Pi RPC exited", child.diagnostics(), redact));
    }
    pending.clear();
  });
  return {
    request: async (command, issued) => {
      if (ended) { throw new Error("Pi RPC has exited"); }
      const id = `oar-pi-${sequence++}`;
      const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
      // Compact is a native operation, not a short query. Caller wait limits must not kill it.
      const timer = command.type === "compact" ? undefined : setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} did not reply within 30 seconds: ${stderr()}`));
        child.kill();
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      // Associate the OAR attempt before the write: a response can arrive
      // synchronously in a transport implementation or fixture.
      issued?.(id);
      child.write(`${JSON.stringify({ ...command, id })}\n`);
      const response = await promise;
      return response;
    },
  };
}

/** The request/response channel of one Pi RPC child. */
export type PiRpcControl = ReturnType<typeof piRpcControl>;
