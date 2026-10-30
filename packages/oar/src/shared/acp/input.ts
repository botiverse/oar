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
