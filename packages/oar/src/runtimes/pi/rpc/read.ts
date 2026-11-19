import { withQueryDeadline } from "../../../shared/executable/query.js";
import type { InventoryOptions } from "../../../contracts/inventory.js";
import { sessionCredentialRedactor } from "../../../shared/credential-redactor.js";
import { workspaceScope } from "../../../shared/inventory.js";
import type { PiRuntimeOptions } from "../options.js";
import { openPiRpc, type OpenPiRpc } from "./open.js";

/** Validate caller input before the reader's native-error boundary. */
export function piRpcReadTimeout(options: InventoryOptions): number {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new RangeError("timeoutMs must be positive and finite"); }
  return timeoutMs;
}

/** One native, non-persistent RPC process; the budget includes version checking and startup. */
export async function readPiRpc<T>(runtime: PiRuntimeOptions, options: InventoryOptions, read: (rpc: OpenPiRpc) => Promise<T>): Promise<T> {
  const timeoutMs = piRpcReadTimeout(options);
  const answer = await withQueryDeadline("Pi RPC reader", timeoutMs, async (signal, own) => {
    const sessionOptions = { cwd: workspaceScope(options).cwd, ...(options.env === undefined ? {} : { env: options.env }) };
    const credentials = sessionCredentialRedactor(sessionOptions);
    const rpc = await openPiRpc(sessionOptions, credentials, () => {}, runtime, { signal, own, noSession: true });
    rpc.child.onExit(() => { rpc.directory.remove(); });
    const result = await read(rpc);
    return result;
  });
  return answer;
}
