import { asRecord, asRecordList, type JsonRecord } from "../json.js";
import { ModelConfirmationError } from "../../contracts/model-confirmation-error.js";
import { acpReportedEffort } from "./model.js";
import { AcpError } from "./errors.js";

type WaitForConfirmation = (signal: AbortSignal) => Promise<void>;

export interface AcpConfigUpdates {
  observe(notification: unknown): void;
  confirm<T>(sessionId: string, configId: string, value: string, run: (wait: WaitForConfirmation) => Promise<T>): Promise<T>;
}

/** Observe before sending; wait after the native answer, inside the same request deadline. */
export function createAcpConfigUpdates(): AcpConfigUpdates {
  const listeners = new Set<(sessionId: string, update: JsonRecord) => void>();
  return {
    observe(notification): void {
      const params = asRecord(notification), update = asRecord(params?.update);
      if (typeof params?.sessionId !== "string" || update?.sessionUpdate !== "config_option_update") { return; }
      for (const listener of listeners) { listener(params.sessionId, update); }
    },
    async confirm(sessionId, configId, value, run) {
      const state: { observed: boolean; current: unknown; effort?: string | null; changed?: () => void } = { observed: false, current: null };
      const listener = (id: string, update: JsonRecord): void => {
        if (id !== sessionId) { return; }
        const option = asRecordList(update.configOptions).find(entry => entry.id === configId);
        if (option === undefined) { return; }
        state.observed = true;
        state.current = option.currentValue;
        state.effort = acpReportedEffort(update);
        state.changed?.();
      };
      listeners.add(listener);
      try {
        return await run(async signal => {
          signal.throwIfAborted();
          if (state.observed && state.current === value) { return; }
          do {
            signal.throwIfAborted();
            const matched = Promise.withResolvers<void>();
            // oxlint-disable-next-line eslint/no-loop-func -- Native callbacks update state; each iteration owns its own deferred.
            state.changed = (): void => { if (state.current === value) { matched.resolve(); } };
            const aborted = (): void => { matched.reject(signal.reason); };
            signal.addEventListener("abort", aborted, { once: true });
            // Recheck after draining the notification callback: another update
            // in the same batch may already have replaced the matching value.
            try { await matched.promise; }
            finally { signal.removeEventListener("abort", aborted); }
          // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- Notifications update the observed state while awaiting.
          } while (state.current !== value);
        });
      } catch (error) {
        // An explicit RPC failure or process exit retains its own classification.
        // A conflicting notification is an observation, not proof of refusal,
        // until the request's existing deadline runs out.
        if (error instanceof AcpError && error.kind === "timeout" && state.observed && state.current !== value) {
          const message = `ACP config_option_update left ${configId} at ${String(state.current)} although ${value} was requested${configId === "model" && typeof state.effort === "string" ? ` (native thought_level=${state.effort})` : ""}`;
          throw configId === "model" ? new ModelConfirmationError(message, { requested: value, reported: typeof state.current === "string" ? state.current : null }) : new Error(message);
        }
        throw error;
      } finally {
        listeners.delete(listener);
      }
    },
  };
}
