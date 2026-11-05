import { asRecord, asRecordList, type JsonRecord } from "../json.js";

export interface AcpConfigUpdates {
  observe(notification: unknown): void;
  confirm<T>(sessionId: string, configId: string, value: string, signal: AbortSignal, send: () => Promise<T>): Promise<T>;
}

/** A native answer and its configuration notification must both finish before the next setting. */
export function createAcpConfigUpdates(): AcpConfigUpdates {
  const listeners = new Set<(sessionId: string, update: JsonRecord) => void>();
  return {
    observe(notification): void {
      const params = asRecord(notification), update = asRecord(params?.update);
      if (typeof params?.sessionId !== "string" || update?.sessionUpdate !== "config_option_update") { return; }
      for (const listener of listeners) { listener(params.sessionId, update); }
    },
    async confirm(sessionId, configId, value, signal, send) {
      signal.throwIfAborted();
      const seen = Promise.withResolvers<void>();
      let current: unknown = null;
      const listener = (id: string, update: JsonRecord): void => {
        if (id !== sessionId) { return; }
        const option = asRecordList(update.configOptions).find(entry => entry.id === configId);
        if (option === undefined) { return; }
        current = option.currentValue;
        seen.resolve();
      };
      const aborted = (): void => { seen.reject(signal.reason); };
      listeners.add(listener);
      signal.addEventListener("abort", aborted, { once: true });
      try {
        const [response] = await Promise.all([send(), seen.promise]);
        if (current !== value) {
          throw new Error(`ACP config_option_update left ${configId} at ${String(current)} although ${value} was requested`);
        }
        return response;
      } finally {
        listeners.delete(listener);
        signal.removeEventListener("abort", aborted);
      }
    },
  };
}
