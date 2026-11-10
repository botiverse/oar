import { randomUUID } from "node:crypto";
import type { RuntimeEventBody, TurnOutcome } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";
import type { AcpNativeTurns } from "./profile.js";

/**
 * The runtime's native turns on the root session, for a profile with
 * `nativeTurns` (grok). OAR names every prompt it sends; the runtime's own
 * queue reports then say when that prompt waits (`input_queued`) and starts
 * (`turn_active`). A turn the runtime runs under any other name is its own:
 * the turn driver adopts it as the active turn (so prompt is busy, held input
 * waits, steer and abort reach it), with `turn_active` at its start and
 * `turn_ended` at its own end report. Only live root frames count: an opening
 * or `_meta.isReplay` frame is history, not a turn.
 *
 * Grok runs one turn at a time, so its next turn can start before OAR records
 * the previous prompt's answer (the answer waits for the SDK's notification
 * flush). A host waiting on that prompt must get the prompt's end, and the
 * next turn must still be running after it: such a start is held until the
 * prompt's turn closes, then reported on that closing frame after its
 * `turn_ended`. A run that also ends before then stays inside the prompt's turn.
 */
export interface AcpNativeTurnTracker {
  /** Name the next OAR prompt; the returned fields go into that prompt's `_meta`. */
  readonly name: (inputId: string | undefined) => JsonRecord;
  readonly sentByOar: (promptId: string) => boolean;
  readonly project: (method: string, params: JsonRecord, rootId: string | undefined, afterOpen: boolean) => readonly RuntimeEventBody[];
  /** The turn driver: its active turn, and adopting or releasing a native one. */
  readonly bind: (control: AcpNativeTurnControl) => void;
  /** An OAR prompt's turn just closed: a native turn that started during it is reported now. */
  readonly afterOarTurn: () => readonly RuntimeEventBody[];
}

export interface AcpNativeTurnControl {
  readonly active: () => object | null;
  readonly adopt: () => object;
  readonly release: (turn: object) => void;
}

const unbound: AcpNativeTurnControl = { active: () => null, adopt: () => ({}), release: () => {} };

export function createAcpNativeTurnTracker(profile: AcpNativeTurns | undefined): AcpNativeTurnTracker | undefined {
  if (profile === undefined) { return undefined; }
  const sent = new Map<string, string | undefined>();
  const queuedReported = new Set<string>();
  const endedReports = new Set<string>();
  let control = unbound;
  let running: string | null = null;
  /** The runtime's own running prompt id, its adopted turn, and whether its start waits for an OAR turn to close. */
  let own: string | null = null;
  let adopted: object | null = null;
  let deferred = false;
  let lastEnded: string | null = null;
  const oarTurnOpen = (): boolean => { const active = control.active(); return active !== null && active !== adopted; };

  const started = (promptId: string): readonly RuntimeEventBody[] => {
    if (own === promptId) { return []; }
    own = promptId;
    lastEnded = null;
    if (oarTurnOpen()) { deferred = true; return []; }
    adopted = control.adopt();
    return [{ kind: "turn_active" }];
  };
  const ended = (promptId: string, outcome: TurnOutcome, key: string | undefined): readonly RuntimeEventBody[] => {
    // A repeated delivery: the same native report, or (without one) the same id with no start since.
    if (key === undefined ? lastEnded === promptId : endedReports.has(key)) { return []; }
    if (key !== undefined) { endedReports.add(key); }
    lastEnded = promptId;
    if (own !== promptId) { return oarTurnOpen() ? [] : [{ kind: "turn_ended", outcome }]; }
    own = null;
    if (deferred) { deferred = false; return []; }
    const turn = adopted;
    adopted = null;
    if (turn !== null) { control.release(turn); }
    return [{ kind: "turn_ended", outcome }];
  };
  return {
    name(inputId) {
      const promptId = `oar-${randomUUID()}`;
      sent.set(promptId, inputId);
      return profile.promptMeta(promptId);
    },
    sentByOar: (promptId) => sent.has(promptId),
    project(method, params, rootId, afterOpen) {
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension envelope.
      if (!afterOpen || rootId === undefined || params.sessionId !== rootId || asRecord(params._meta)?.isReplay === true) { return []; }
      const report = profile.read(method, params);
      if (report === null) { return []; }
      if (report.kind === "ended") { return sent.has(report.promptId) ? [] : ended(report.promptId, report.outcome, report.key); }
      const events: RuntimeEventBody[] = [];
      for (const promptId of report.queued) {
        const inputId = sent.get(promptId);
        if (inputId !== undefined && !queuedReported.has(promptId)) {
          queuedReported.add(promptId);
          events.push({ kind: "input_queued", inputId });
        }
      }
      if (report.running === running) { return events; }
      running = report.running;
      if (running === null) { return events; }
      if (!sent.has(running)) { return [...events, ...started(running)]; }
      const inputId = sent.get(running);
      return [...events, { kind: "turn_active", ...(inputId === undefined ? {} : { inputId }) }];
    },
    bind(next) { control = next; },
    afterOarTurn() {
      if (own === null || !deferred) { return []; }
      deferred = false;
      adopted = control.adopt();
      return [{ kind: "turn_active" }];
    },
  };
}
