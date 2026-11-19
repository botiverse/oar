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
 * after the turn's `since` and before the frame that closed it (one
 * requested after that belongs to a later turn, even while the abort's
 * answer is still pending). When an aborted turn closes, OAR stops those
 * still running and records the outcome as a `cleanup` response on the abort
 * request. Terminals of earlier turns (a background command) are spared.
 * Semantics: docs/runtimes/grok.md#ending-a-turns-processes-on-abort.
 */

export interface AcpTurnTerminals {
  /** An abort of this turn is about to be sent; report its answer through the claim. */
  aborting(state: ActiveTurn, request: RequestRecord): { readonly accepted: () => void; readonly refused: () => void };
}

interface PendingAbort {
  readonly requests: Map<string, "sent" | "accepted">;
  outcome?: "aborted" | "other";
}

const accepted = (abort: PendingAbort): string[] => [...abort.requests].flatMap(([id, answer]) => answer === "accepted" ? [id] : []);

const passive: AcpTurnTerminals = { aborting: () => ({ accepted() {}, refused() {} }) };

export function acpTurnTerminals(enabled: boolean, kernel: SessionKernel, host: Pick<OwnedAcpTerminalHost, "end">, active: () => ActiveTurn | null): AcpTurnTerminals {
  if (!enabled) { return passive; }
  const creating = new Map<string, ActiveTurn>();
  const terminals = new WeakMap<ActiveTurn, string[]>();
  const pending = new Map<ActiveTurn, PendingAbort>();
  const record = (ids: readonly string[], result: SessionCleanup): void => {
    for (const id of ids) { kernel.respond(id, { kind: "cleanup", result }); }
  };
  const end = async (turn: ActiveTurn, requests: readonly string[]): Promise<void> => {
    try {
      const { signalled } = await host.end(terminals.get(turn) ?? []);
      record(requests, { kind: "completed", signalled });
    } catch (error) {
      record(requests, { kind: "failed", reason: `stopping the aborted turn's terminals failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const settle = (turn: ActiveTurn): void => {
    const abort = pending.get(turn);
    if (abort === undefined || abort.outcome === undefined || [...abort.requests.values()].includes("sent")) { return; }
    if (abort.outcome === "aborted" && [...creating.values()].includes(turn)) { return; }
    pending.delete(turn);
    const requests = accepted(abort);
    if (requests.length === 0) { return; }
    if (abort.outcome === "aborted") { void end(turn, requests); }
    else { record(requests, { kind: "completed", signalled: 0 }); }
  };
  kernel.rawEvents((event) => {
    if (event.sessionId !== kernel.sessionId) { return; }
    if (event.kind === "request") {
      if (event.direction === "toApp" && event.body.kind === "native" && event.body.type === "terminal/create") {
        const turn = active();
        if (turn !== null && turn.request?.body.kind !== "compact") { creating.set(event.id, turn); }
      }
      return;
    }
    if (event.kind === "response") {
      const turn = creating.get(event.requestId);
      if (turn !== undefined && event.body.kind === "answered") {
        creating.delete(event.requestId);
        const id = asRecord(event.body.native)?.terminalId;
        if (typeof id === "string") {
          const ids = terminals.get(turn) ?? [];
          ids.push(id);
          terminals.set(turn, ids);
        }
        settle(turn);
      }
      if (event.body.kind === "released" || event.body.kind === "exited") {
        const fallback = event.body.kind === "released" && event.body.reason === "abort_fallback" ? event.requestId : null;
        for (const abort of pending.values()) {
          record(accepted(abort).filter(id => id !== fallback), { kind: "failed", reason: "Session became unavailable before turn cleanup was confirmed" });
        }
        pending.clear();
        creating.clear();
      }
      return;
    }
    const ended = event.body.events.find(body => body.kind === "turn_ended");
    if (ended === undefined) { return; }
    for (const [turn, abort] of pending) {
      if (abort.outcome === undefined && active() !== turn) {
        abort.outcome = ended.outcome.kind === "aborted" ? "aborted" : "other";
        settle(turn);
      }
    }
  });
  return {
    aborting(turn, request) {
      if (turn.request?.body.kind === "compact") { return passive.aborting(turn, request); }
      const abort = pending.get(turn) ?? { requests: new Map<string, "sent" | "accepted">() };
      abort.requests.set(request.id, "sent");
      pending.set(turn, abort);
      return {
        accepted() { if (pending.get(turn) === abort) { abort.requests.set(request.id, "accepted"); settle(turn); } },
        refused() { abort.requests.delete(request.id); if (abort.requests.size === 0) { pending.delete(turn); } else { settle(turn); } },
      };
    },
  };
}
