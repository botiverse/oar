/* oxlint-disable import/max-dependencies -- This guard composes control plans, process-table reads and the record stream. */
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionCleanup, SessionOpenContext } from "../../contracts/placement.js";
import type { RequestRecord, SessionOptions } from "../../contracts/session.js";
import type { CancellationObservation } from "../../shared/executable/process-cancellation.js";
import { processTableSource } from "../../shared/executable/process-table-async.js";
import { observeProcessTableWithin } from "../../shared/executable/process-table-budget.js";
import { processTableFailure, type ProcessEntry, type ProcessTable, type ProcessTableObservation, type SignalReport } from "../../shared/executable/process-tree.js";
import { endTurnEntries, turnEntries, type ProcessTableReading } from "../../shared/executable/process-turn-scope.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { AppServerClient } from "./app-server-client.js";
import type { RpcControlPlan } from "./rpc-control.js";

/*
 * SessionOptions.endTurnProcessesOnAbort. Native turn/interrupt can leave the
 * running command and a detached child alive, and the native terminal APIs
 * neither reach a detached child nor spare earlier work, so OAR compares two
 * process-table reads: one started before turn/start, one before turn/interrupt.
 * Semantics and record shape: docs/runtimes/codex.md, docs/spec/record-stream.md.
 *
 * All state belongs to one turn, by native turn id once known. A record of the
 * old turn's end is published before this module hears of it, and an observer
 * can prompt from there: nothing an old turn does may reach a newer one.
 */

/** Each read's own limit, as for the cleanup reads of a slow `ps`. */
const READ_BUDGET_MS = 5000;

/** Process groups are what tell the runtime's own work and an MCP server's workers from a turn's commands. */
const NO_PROCESS_GROUPS = "Windows has no process groups to tell this turn's processes from codex's own helpers and an MCP server's workers";

/** A baseline read: `result` stays null until it settles. */
interface Baseline { result: ProcessTableObservation | null }

/** The turn one `prompt` asked for: `turnId` is null until its turn/start reply names it. */
interface PromptedTurn { readonly baseline: Baseline; turnId: string | null }

/** What one turn's abort knows at the moment the interrupt may be sent. */
interface AbortEvidence {
  readonly turnId: string;
  readonly cancellation: CancellationObservation;
  /** Whether this turn had a baseline read started, and how it stood when the snapshot settled. */
  readonly baselineStarted: boolean;
  readonly baseline: ProcessTableObservation | null;
  /** Abort requests whose interrupt was sent and not refused. */
  readonly requests: Set<string>;
}

/** The observation one turn's aborts share. */
interface AbortAttempt {
  readonly observing: Promise<AbortEvidence>;
  ended: boolean;
  /** Set once an interrupt was sent on this evidence. */
  sent: AbortEvidence | null;
}

interface Readings { readonly root: number; readonly baseline: ProcessTable; readonly snapshot: ProcessTableReading }

export interface CodexTurnProcesses {
  /** Start a baseline read when a prompt is admitted; never delays its turn/start. */
  prompting<Args extends unknown[]>(plan: (...args: Args) => RpcControlPlan): (...args: Args) => RpcControlPlan;
  /** Take the snapshot before the interrupt is sent; a refusal ends this attempt's claim. */
  aborting(plan: () => RpcControlPlan): () => RpcControlPlan;
  /** A root turn/completed, after its frame is recorded. Touches that turn's state only. */
  turnCompleted(params: JsonRecord): void;
  /** The app-server exited, before its `exited` response is recorded. */
  exited(): void;
  /** Resolves when no ending is in flight. */
  settled(): Promise<void>;
}

const passive: CodexTurnProcesses = {
  prompting: (plan) => plan,
  aborting: (plan) => plan,
  turnCompleted() {},
  exited() {},
  async settled() { await Promise.resolve(); },
};

function readFailure(what: string, result: Exclude<ProcessTableObservation, { readonly ok: true }>): string {
  return `${what} process table read failed: ${result.reason}`;
}

/** The two usable reads, or why there are not two: nothing is ended without both. */
function usableReadings(evidence: AbortEvidence, root: number | undefined): Readings | string {
  if (processTableSource() === "windows") { return NO_PROCESS_GROUPS; }
  const { baseline, baselineStarted, cancellation: { observation: snapshot } } = evidence;
  if (!baselineStarted) { return "no baseline: OAR did not start this turn with a prompt"; }
  if (baseline === null) { return "the baseline process table read had not finished"; }
  if (!baseline.ok) { return readFailure("the baseline", baseline); }
  if (snapshot === undefined) { return "no snapshot of the app-server's processes could be taken"; }
  if (!snapshot.ok) { return readFailure("the pre-interrupt snapshot", snapshot); }
  if (root === undefined) { return "the app-server has no process id"; }
  const held = baseline.table.get(root);
  if (held === undefined || snapshot.table.get(root)?.start !== held.start) { return "the app-server is not the same process in both reads"; }
  return { root, baseline: baseline.table, snapshot };
}

/** What a round of signals amounts to: a signal that was not sent is never reported as sent. */
function cleanupOf(report: SignalReport): SessionCleanup {
  if (!report.hostIdentified) { return { kind: "failed", reason: "the host is not in the revalidating process table, so nothing was signalled" }; }
  if (report.failed === 0) { return { kind: "completed", signalled: report.signalled }; }
  const reason = `${String(report.failed)} of ${String(report.failed + report.signalled)} processes could not be signalled: ${report.codes.join(", ")}`;
  return { kind: "failed", reason, ...(report.signalled === 0 ? {} : { signalled: report.signalled }) };
}

/** End an attempt and return its evidence, if an interrupt stands. */
function closeAttempt(attempt: AbortAttempt): { readonly evidence: AbortEvidence; readonly requestId: string } | null {
  attempt.ended = true;
  const evidence = attempt.sent;
  attempt.sent = null;
  if (evidence === null) { return null; }
  evidence.cancellation.complete();
  const [requestId] = evidence.requests;
  return requestId === undefined ? null : { evidence, requestId };
}

/** Shared placement cannot tell one session's turn from another's in the common process table. */
export function refuseSharedTurnProcesses(options: SessionOptions, context: SessionOpenContext): void {
  if (options.endTurnProcessesOnAbort === true && context.placement === "shared") {
    throw new UnsupportedOptionError("endTurnProcessesOnAbort", "A shared app-server's process table does not say which session's turn started a process");
  }
}

export function codexTurnProcesses(options: SessionOptions, kernel: SessionKernel, client: Pick<AppServerClient, "rootPid" | "observeCancellation">): CodexTurnProcesses {
  if (options.endTurnProcessesOnAbort !== true) { return passive; }
  let prompted: PromptedTurn | null = null;
  const attempts = new Map<string, AbortAttempt>();
  const ending = new Set<Promise<void>>();

  const startBaseline = (): PromptedTurn | null => {
    if (processTableSource() === "windows") { return null; }
    const baseline: Baseline = { result: null };
    void (async (): Promise<void> => {
      try { baseline.result = await observeProcessTableWithin(READ_BUDGET_MS, processTableSource(), { background: true }); }
      catch (error) { baseline.result = processTableFailure(error, processTableSource(), 0); }
    })();
    return { baseline, turnId: null };
  };
  /** A prompt's baseline serves its own turn, or whatever is running before its reply names that turn: every process it holds is older than both. */
  const baselineOf = (turnId: string): Baseline | null => (prompted !== null && (prompted.turnId === null || prompted.turnId === turnId) ? prompted.baseline : null);
  const observe = async (turnId: string): Promise<AbortEvidence> => {
    const held = baselineOf(turnId);
    let cancellation: CancellationObservation = { commit() {}, complete() {} };
    // A snapshot nothing can act on must not delay the interrupt.
    try { if (processTableSource() !== "windows") { cancellation = await client.observeCancellation(); } }
    // Cancellation must proceed whatever this read does; the evidence stays failed.
    catch (error) { cancellation = { ...cancellation, observation: processTableFailure(error, processTableSource(), 0) }; }
    return { turnId, cancellation, baselineStarted: held !== null, baseline: held?.result ?? null, requests: new Set() };
  };
  const record = (requestId: string, result: SessionCleanup): void => { kernel.respond(requestId, { kind: "cleanup", result }); };
  const end = async (requestId: string, readings: Readings, targets: readonly ProcessEntry[]): Promise<void> => {
    try {
      const fresh = await observeProcessTableWithin(READ_BUDGET_MS);
      record(requestId, fresh.ok ? cleanupOf(endTurnEntries(readings.root, targets, readings.baseline, fresh)) : { kind: "failed", reason: readFailure("the revalidating", fresh) });
    } catch (error) {
      record(requestId, { kind: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  };
  const decide = (requestId: string, evidence: AbortEvidence, turn: JsonRecord | null): void => {
    if (turn?.id !== evidence.turnId || turn.status !== "interrupted") {
      record(requestId, { kind: "failed", reason: `the turn ended with status ${String(turn?.status)}, not by this interrupt` });
      return;
    }
    const readings = usableReadings(evidence, client.rootPid());
    if (typeof readings === "string") {
      record(requestId, { kind: "failed", reason: readings });
      return;
    }
    const targets = turnEntries(readings.root, readings.baseline, readings.snapshot);
    if (targets.length === 0) {
      record(requestId, { kind: "completed", signalled: 0 });
      return;
    }
    const running = end(requestId, readings, targets);
    ending.add(running);
    void (async (): Promise<void> => { await running; ending.delete(running); })();
  };

  return {
    prompting: (plan) => (...args) => {
      const base = plan(...args);
      let own: PromptedTurn | null = null;
      const withdraw = (): void => { if (prompted === own) { prompted = null; } };
      return {
        ...base,
        gate: (request) => {
          const refused = base.gate(request);
          if (refused === null) { own = startBaseline(); prompted = own; }
          return refused;
        },
        onReply: (reply) => {
          const body = base.onReply(reply);
          const turnId = asRecord(reply.turn)?.id;
          if (body.kind === "rejected" || typeof turnId !== "string") { withdraw(); }
          else if (own !== null) { own.turnId = turnId; }
          return body;
        },
        onError: (message, native) => {
          withdraw();
          return base.onError(message, native);
        },
      };
    },
    aborting: (plan) => () => {
      const base = plan();
      let issued: RequestRecord | null = null;
      let joined: AbortAttempt | null = null;
      return {
        ...base,
        gate: (request) => {
          issued = request;
          return base.gate(request);
        },
        prepare: async () => {
          const turnId = String(base.params().turnId);
          const attempt = attempts.get(turnId) ?? { observing: observe(turnId), ended: false, sent: null };
          attempts.set(turnId, attempt);
          joined = attempt;
          const evidence = await attempt.observing;
          const unreachable = kernel.unreachable();
          if (unreachable !== null || attempt.ended || issued === null) {
            evidence.cancellation.complete();
            if (attempts.get(turnId) === attempt) { attempts.delete(turnId); }
            return unreachable ?? { kind: "rejected", code: "no_active_turn", reason: "turn ended before the interrupt was sent" };
          }
          evidence.cancellation.commit();
          evidence.requests.add(issued.id);
          attempt.sent = evidence;
          return null;
        },
        onError: (message, native) => {
          const evidence = joined?.sent;
          if (issued !== null && joined !== null && evidence?.requests.delete(issued.id) === true && evidence.requests.size === 0) {
            evidence.cancellation.complete();
            joined.sent = null;
            if (attempts.get(evidence.turnId) === joined) { attempts.delete(evidence.turnId); }
          }
          return base.onError(message, native);
        },
      };
    },
    turnCompleted(params) {
      const turn = asRecord(params.turn);
      const id = turn?.id;
      if (typeof id === "string" && prompted?.turnId === id) { prompted = null; }
      // A completion that names no turn cannot be matched, so it closes what is open and interrupts nothing.
      const named = typeof id === "string" ? attempts.get(id) : undefined;
      const closing = typeof id === "string" ? (named === undefined ? [] : [named]) : [...attempts.values()];
      if (typeof id === "string") { attempts.delete(id); } else { attempts.clear(); }
      for (const attempt of closing) {
        const closed = closeAttempt(attempt);
        if (closed !== null) { decide(closed.requestId, closed.evidence, turn); }
      }
    },
    exited() {
      prompted = null;
      const closing = [...attempts.values()];
      attempts.clear();
      for (const attempt of closing) {
        const closed = closeAttempt(attempt);
        if (closed !== null) { record(closed.requestId, { kind: "failed", reason: "the app-server exited before the aborted turn ended; its exit cleanup applies instead" }); }
      }
    },
    async settled() { await Promise.all(ending); },
  };
}
