/** Cancelling protocol dispatch must not break the agent's stdout before shutdown. */
export function drainingAcpInput(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = input.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (cancelled) { return; }
        if (item.done) { controller.close(); }
        else { controller.enqueue(item.value); }
      } catch (error) {
        if (!cancelled) { controller.error(error); }
      }
    },
    async cancel() {
      cancelled = true;
      // Keep consuming bytes, without parsing or delivering them to the SDK,
      // until native exit closes stdout. Never propagate cancellation upstream.
      try {
        let item = await reader.read();
        while (!item.done) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Consume the byte stream sequentially without buffering it.
          item = await reader.read();
        }
      }
      catch { /* Native exit and stderr remain the process result. */ }
    },
  });
}

/** Preserve normal EOF's identity when the SDK closes its connection. */
export function acpEofInput<T>(input: ReadableStream<T>): { readonly readable: ReadableStream<T>; readonly eof: Error } {
  const reader = input.getReader();
  // The SDK otherwise constructs an indistinguishable generic close error.
  // This private marker has the same message but is compared by identity.
  const eof = new Error("ACP connection closed");
  const readable = new ReadableStream<T>({
    async pull(controller): Promise<void> {
      try {
        const item = await reader.read();
        if (item.done) { reader.releaseLock(); controller.error(eof); }
        else { controller.enqueue(item.value); }
      } catch (error) { reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason: unknown): Promise<void> {
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    },
  // Do not prefetch EOF past a frame the SDK has not processed yet. A native
  // batch or another protocol failure must retain its own close reason.
  }, { highWaterMark: 0 });
  return { readable, eof };
}
