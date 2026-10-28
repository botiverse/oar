import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

function connectTarget(args: readonly unknown[]): string {
  const [first, second]: readonly unknown[] = Array.isArray(args[0]) ? args[0] : args;
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/u.test(first))) {
    return `${typeof second === "string" ? second : "localhost"}:${String(first)}`;
  }
  if (typeof first === "object" && first !== null) {
    if ("path" in first && typeof first.path === "string") { return `pipe:${first.path}`; }
    const port = "port" in first ? String(first.port) : "?";
    return `${"host" in first && typeof first.host === "string" ? first.host : "localhost"}:${port}`;
  }
  return "unknown target";
}

/** Refuse external traffic; record native file reads without changing their results. */
export function observeLocalOnly(port: number): { readonly reads: string[]; readonly blocked: string[]; restore(): void } {
  const reads: string[] = [];
  const blocked: string[] = [];
  const allowed = new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply restores the original socket receiver.
  const { connect } = net.Socket.prototype;
  const read = fs.readFile;
  const { open } = fs;
  function guarded(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTarget(args);
    if (!allowed.has(target)) { blocked.push(target); throw new Error("configuration probe refused nonlocal traffic"); }
    const socket: unknown = Reflect.apply(connect, this, args);
    assert.ok(socket instanceof net.Socket);
    return socket;
  }
  async function observedRead(...args: unknown[]): Promise<unknown> {
    if (typeof args[0] === "string") { reads.push(args[0]); }
    const result: unknown = await Reflect.apply(read, fs, args);
    return result;
  }
  // SDK 1.2.0's text decoder reads through a FileHandle. Observe the read,
  // not merely opening the path, and preserve the native handle and result.
  async function observedOpen(...args: Parameters<typeof fs.open>): Promise<Awaited<ReturnType<typeof fs.open>>> {
    const handle = await open(...args);
    const readHandle = handle.readFile.bind(handle);
    Object.defineProperty(handle, "readFile", {
      configurable: true, writable: true,
      value: async (...options: Parameters<typeof handle.readFile>) => {
        if (typeof args[0] === "string") { reads.push(args[0]); }
        const result = await readHandle(...options);
        return result;
      },
    });
    return handle;
  }
  Object.defineProperty(net.Socket.prototype, "connect", { value: guarded, configurable: true, writable: true });
  Object.defineProperty(fs, "readFile", { value: observedRead, configurable: true, writable: true });
  Object.defineProperty(fs, "open", { value: observedOpen, configurable: true, writable: true });
  syncBuiltinESMExports();
  return {
    reads, blocked,
    restore(): void {
      Object.defineProperty(net.Socket.prototype, "connect", { value: connect });
      Object.defineProperty(fs, "readFile", { value: read });
      Object.defineProperty(fs, "open", { value: open });
      syncBuiltinESMExports();
    },
  };
}
