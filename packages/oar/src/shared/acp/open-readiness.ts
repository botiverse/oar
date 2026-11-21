import type { JsonRecord } from "../json.js";
import type { AcpConfigUpdates } from "./config-updates.js";
import { withAcpDeadline, type AcpProcess } from "./process.js";

/** Runtime startup reports can arrive before the native open reply identifies the session. */
export interface AcpOpenReadiness {
  readonly method: string;
  observe(method: string, params: JsonRecord): void;
  wait(sessionId: string, signal: AbortSignal): Promise<void>;
}

export interface AcpOpenObservers {
  readonly configUpdates: AcpConfigUpdates;
  readonly readiness: AcpOpenReadiness | undefined;
}

export async function waitForOpenReadiness(process: AcpProcess, readiness: AcpOpenReadiness | undefined, sessionId: string, timeoutMs: number, startedAt: number): Promise<void> {
  if (readiness === undefined) { return; }
  await withAcpDeadline(process, readiness.method, timeoutMs, async (request) => {
    const signal = request?.cancellationSignal;
    await readiness.wait(sessionId, signal === undefined ? process.connection.signal : AbortSignal.any([signal, process.connection.signal]));
  }, startedAt);
}
