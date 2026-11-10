import { randomUUID } from "node:crypto";
import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import type { AcpNativeTurns } from "./profile.js";

/**
 * The runtime's native turns on the root session, for a profile with
 * `nativeTurns` (grok). OAR names every prompt it sends; the runtime's own
 * queue reports then say when that prompt waits (`input_queued`) and starts
 * (`turn_active`). A turn the runtime runs under any other name is its own:
 * `turn_active` at its start, `turn_ended` at its own end report, so a host
 * folding the stream returns to idle. Only live root frames count: an
 * opening or `_meta.isReplay` frame is history, not a turn.
 *
 * While an OAR prompt's turn is still open, the runtime's own turn is not
 * reported apart: Grok runs one turn at a time, so its next turn can start
 * before OAR records the previous prompt's answer (the answer waits for the
 * SDK's notification flush), and a host waiting on that prompt must see its
 * end, not the next turn's. Such a turn's frames stay inside the OAR turn.
 */
export interface AcpNativeTurnTracker {
  /** Name the next OAR prompt; the returned fields go into that prompt's `_meta`. */
  readonly name: (inputId: string | undefined) => JsonRecord;
  readonly sentByOar: (promptId: string) => boolean;
  /** A runtime-run turn has started and not yet ended. */
  readonly busy: () => boolean;
  readonly project: (method: string, params: JsonRecord, rootId: string | undefined, afterOpen: boolean) => readonly RuntimeEventBody[];
  /** Called when the runtime's own turn ends, so held input can go. */
  readonly onIdle: (listener: () => void) => void;
  /** Whether an OAR prompt's turn is open (turns.ts). */
  readonly bindOarTurn: (open: () => boolean) => void;
}

const never = (): boolean => false;

export function createAcpNativeTurnTracker(profile: AcpNativeTurns | undefined): AcpNativeTurnTracker | undefined {
  if (profile === undefined) { return undefined; }
  const sent = new Map<string, string | undefined>();
  const queuedReported = new Set<string>();
  const ended = new Set<string>();
  let running: string | null = null;
  let own: string | null = null;
  let oarTurnOpen = never;
  const listeners: (() => void)[] = [];
  return {
    name(inputId) {
      const promptId = `oar-${randomUUID()}`;
      sent.set(promptId, inputId);
      return profile.promptMeta(promptId);
    },
    sentByOar: (promptId) => sent.has(promptId),
    busy: () => own !== null,
    project(method, params, rootId, afterOpen) {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension envelope.
      if (!afterOpen || rootId === undefined || params.sessionId !== rootId || asRecord(params._meta)?.isReplay === true) { return []; }
      const report = profile.read(method, params);
      if (report === null) { return []; }
      const events: RuntimeEventBody[] = [];
      if (report.kind === "queue") {
        for (const promptId of report.queued) {
          const inputId = sent.get(promptId);
          if (inputId !== undefined && !queuedReported.has(promptId)) {
            queuedReported.add(promptId);
            events.push({ kind: "input_queued", inputId });
          }
        }
        if (report.running === running) { return events; }
        running = report.running;
        if (running === null || ended.has(running)) { return events; }
        if (sent.has(running)) {
          const inputId = sent.get(running);
          events.push({ kind: "turn_active", ...(inputId === undefined ? {} : { inputId }) });
        } else if (own !== running) {
          own = running;
          if (!oarTurnOpen()) { events.push({ kind: "turn_active" }); }
        }
        return events;
      }
      // An OAR prompt's own answer ends its turn (turns.ts); a duplicate end report is history.
      if (sent.has(report.promptId) || ended.has(report.promptId)) { return []; }
      ended.add(report.promptId);
      if (own === report.promptId) {
        own = null;
        for (const listener of listeners) { queueMicrotask(listener); }
      }
      return oarTurnOpen() ? [] : [{ kind: "turn_ended", outcome: report.outcome }];
    },
    onIdle(listener) { listeners.push(listener); },
    bindOarTurn(open) { oarTurnOpen = open; },
  };
}
