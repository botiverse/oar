import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";

/** Register each private key before acknowledging the child's native hook. */
export function readPiRpcCredentials(pipe: Duplex, remember: (key: string) => void, failed: () => void): void {
  const lines = createInterface({ input: pipe, crlfDelay: Infinity });
  // readline forwards input errors to its own emitter. Both need listeners,
  // including when a child exits before the acknowledgment can be written.
  pipe.on("error", failed);
  lines.on("error", failed);
  lines.on("line", (line) => {
    try {
      const key: unknown = JSON.parse(line);
      if (typeof key !== "string") { throw new TypeError("Invalid Pi RPC credential message"); }
      remember(key);
      // Separate stdout and fd 3 reads have no cross-stream ordering.
      pipe.write("ok\n");
    } catch { failed(); }
  });
}
