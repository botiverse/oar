import type { SessionCleanup } from "../../contracts/placement.js";
import type { RequestRecord } from "../../contracts/session.js";
import { asRecord } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";
import type { OwnedAcpTerminalHost } from "./terminal.js";
import type { ActiveTurn } from "./turns.js";

/*
 * SessionOptions.endTurnProcessesOnAbort on an ACP runtime whose commands run
 * in terminals OAR hosts (grok). The runtime asks OAR for each terminal
 * (`terminal/create`, a toApp request record answered with its terminalId),
 * so the terminals one turn created are exactly those whose request comes
 * after the turn's `since`. When an aborted turn closes, OAR stops those
 * still running and records the outcome as a `cleanup` response on the abort
 * request. Terminals of earlier turns (a background command) are spared.
 * Semantics: docs/runtimes/grok.md#ending-a-turns-processes-on-abort.
 */

export interface AcpTurnTerminals {
  /** An abort of this turn is about to be sent; `refused` undoes it if the abort was not accepted. */
  aborting(state: ActiveTurn, request: RequestRecord): { readonly refused: () => void };
}

interface PendingAbort { readonly state: ActiveTurn; readonly requests: Set<string> }

const passive: AcpTurnTerminals = { aborting: () => ({ refused() {} }) };

export function acpTurnTerminals(enabled: boolean, kernel: SessionKernel, host: Pick<OwnedAcpTerminalHost, "end">, active: () => ActiveTurn | null): AcpTurnTerminals {
  if (!enabled) { return passive; }
  /** terminal/create requests awaiting their answer, by request id: the request's seq. */
  const creating = new Map<string, number>();
  const created: { readonly seq: number; readonly terminalId: string }[] = [];
  const pending = new Map<ActiveTurn, PendingAbort>();
  const record = (abort: PendingAbort, result: SessionCleanup): void => {
    for (const requestId of abort.requests) { kernel.respond(requestId, { kind: "cleanup", result }); }
  };
  const end = async (abort: PendingAbort): Promise<void> => {
    const ids = created.filter((entry) => entry.seq > abort.state.since).map((entry) => entry.terminalId);
    try {
      const { signalled } = await host.end(ids);
      record(abort, { kind: "completed", signalled });
    } catch (error) {
      record(abort, { kind: "failed", reason: `stopping the aborted turn's terminals failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const finish = (abort: PendingAbort): void => {
    pending.delete(abort.state);
    void end(abort);
  };
  kernel.rawEvents((event) => {
    if (event.kind === "request") {
      if (event.direction === "toApp" && event.body.kind === "native" && event.body.type === "terminal/create") { creating.set(event.id, event.seq); }
      return;
    }
    if (event.kind === "response") {
      const seq = creating.get(event.requestId);
      if (seq !== undefined && event.body.kind === "answered") {
        creating.delete(event.requestId);
        const terminalId = asRecord(event.body.native)?.terminalId;
        if (typeof terminalId === "string") { created.push({ seq, terminalId }); }
      }
      if (event.body.kind === "exited" || event.body.kind === "released") {
        const reason = event.body.kind === "exited" ? "the runtime exited before the aborted turn ended; its exit cleanup applies instead" : "OAR released the session before the aborted turn ended; dispose ends its terminals";
        for (const abort of pending.values()) { record(abort, { kind: "failed", reason }); }
        pending.clear();
      }
      return;
    }
    if (event.body.events.some((body) => body.kind === "turn_ended")) {
      for (const abort of pending.values()) {
        if (active() !== abort.state) { finish(abort); }
      }
    }
  });
  return {
    aborting(state, request) {
      const abort = pending.get(state) ?? { state, requests: new Set<string>() };
      abort.requests.add(request.id);
      pending.set(state, abort);
      return {
        refused() {
          abort.requests.delete(request.id);
          if (abort.requests.size === 0) { pending.delete(state); }
        },
      };
    },
  };
}
