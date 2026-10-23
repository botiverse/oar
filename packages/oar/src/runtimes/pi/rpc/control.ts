import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import type { LineProcess } from "../../../shared/executable/index.js";
import { asRecord, parseJson } from "../../../shared/json.js";

/** Native Pi JSONL correlation. Event observers never wait for a command response. */
export function piRpcControl(child: LineProcess, receive: (message: Record<string, unknown>) => void): {
  request(command: RpcCommand): Promise<RpcResponse>;
} {
  let sequence = 0;
  let ended = false;
  const pending = new Map<string, { resolve(value: RpcResponse): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
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
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- The pinned bundled RPC encoder owns this response union.
    waiter.resolve(message as unknown as RpcResponse);
  });
  child.onExit((code) => {
    ended = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Pi RPC exited (${String(code)}): ${child.diagnostics().stderr}`));
    }
    pending.clear();
  });
  return {
    request: async (command) => {
      if (ended) { throw new Error("Pi RPC has exited"); }
      const id = `oar-pi-${sequence++}`;
      const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} did not reply within 30 seconds: ${child.diagnostics().stderr}`));
        child.kill();
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      child.write(`${JSON.stringify({ ...command, id })}\n`);
      const response = await promise;
      return response;
    },
  };
}
