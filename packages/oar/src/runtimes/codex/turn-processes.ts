/* oxlint-disable import/max-dependencies -- This guard composes control plans, process-table reads and the record stream. */
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionCleanup, SessionOpenContext } from "../../contracts/placement.js";
import type { RequestRecord, SessionOptions } from "../../contracts/session.js";
import type { CancellationObservation } from "../../shared/executable/process-cancellation.js";
import { processTableSource } from "../../shared/executable/process-table-async.js";
import { observeProcessTableWithin } from "../../shared/executable/process-table-budget.js";
import { processTableFailure, type ProcessEntry, type ProcessTable, type ProcessTableObservation } from "../../shared/executable/process-tree.js";
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
 */

/** Each read's own limit, as for a Windows cleanup read: a cold CIM query can outlast one second. */
const READ_BUDGET_MS = 5000;

/** A baseline read: `result` stays null until it settles. */
interface Baseline { result: ProcessTableObservation | null }

/** What one turn's abort knows at the moment the interrupt may be sent. */
interface AbortEvidence {
  readonly turnId: unknown;
  readonly cancellation: CancellationObservation;
  /** Whether this turn had a baseline read started, and how it stood when the snapshot settled. */
  readonly baselineStarted: boolean;
  readonly baseline: ProcessTableObservation | null;
  /** Abort requests whose interrupt was sent and not refused. */
  readonly requests: Set<string>;
}

interface Readings { readonly root: number; readonly baseline: ProcessTable; readonly snapshot: ProcessTableReading }

export interface CodexTurnProcesses {
  /** Start a baseline read when a prompt is admitted; never delays its turn/start. */
  prompting<Args extends unknown[]>(plan: (...args: Args) => RpcControlPlan): (...args: Args) => RpcControlPlan;
  /** Take the snapshot before the interrupt is sent; a refusal ends this attempt's claim. */
  aborting(plan: () => RpcControlPlan): () => RpcControlPlan;
  /** A root turn/completed, after its frame is recorded. */
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

/** Shared placement cannot tell one session's turn from another's in the common process table. */
export function refuseSharedTurnProcesses(options: SessionOptions, context: SessionOpenContext): void {
  if (options.endTurnProcessesOnAbort === true && context.placement === "shared") {
    throw new UnsupportedOptionError("endTurnProcessesOnAbort", "A shared app-server's process table does not say which session's turn started a process");
  }
}

export function codexTurnProcesses(options: SessionOptions, kernel: SessionKernel, client: Pick<AppServerClient, "rootPid" | "observeCancellation">): CodexTurnProcesses {
  if (options.endTurnProcessesOnAbort !== true) { return passive; }
  let baseline: Baseline | null = null;
  // The observation one turn's aborts share, and the evidence once an interrupt was sent.
  let observing: Promise<AbortEvidence> | null = null;
  let sent: AbortEvidence | null = null;
  let turnEnds = 0;
  const ending = new Set<Promise<void>>();

  const startBaseline = (): void => {
    const started: Baseline = { result: null };
    baseline = started;
    void (async (): Promise<void> => {
      try { started.result = await observeProcessTableWithin(READ_BUDGET_MS, processTableSource(), { background: true }); }
      catch (error) { started.result = processTableFailure(error, processTableSource(), 0); }
    })();
  };
  const observe = async (turnId: unknown): Promise<AbortEvidence> => {
    const held = baseline;
    let cancellation: CancellationObservation = { commit() {}, complete() {} };
    try { cancellation = await client.observeCancellation(); }
    // Cancellation must proceed whatever this read does; the evidence stays failed.
    catch (error) { cancellation = { ...cancellation, observation: processTableFailure(error, processTableSource(), 0) }; }
    return { turnId, cancellation, baselineStarted: held !== null, baseline: held?.result ?? null, requests: new Set() };
  };
  const record = (requestId: string, result: SessionCleanup): void => { kernel.respond(requestId, { kind: "cleanup", result }); };
  const end = async (requestId: string, readings: Readings, targets: readonly ProcessEntry[]): Promise<void> => {
    try {
      const fresh = await observeProcessTableWithin(READ_BUDGET_MS);
      if (fresh.ok) { record(requestId, { kind: "completed", signalled: endTurnEntries(readings.root, targets, readings.baseline, fresh) }); }
      else { record(requestId, { kind: "failed", reason: readFailure("the revalidating", fresh) }); }
    } catch (error) {
      record(requestId, { kind: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  };
  const decide = (requestId: string, evidence: AbortEvidence, turn: JsonRecord | null): void => {
    if (turn?.id !== evidence.turnId || turn?.status !== "interrupted") {
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
  /** The interrupted turn is over: clear its state and return the evidence, if an interrupt stands. */
  const closeTurn = (): { readonly evidence: AbortEvidence; readonly requestId: string } | null => {
    turnEnds += 1;
    const evidence = sent;
    baseline = null;
    observing = null;
    sent = null;
    if (evidence === null) { return null; }
    evidence.cancellation.complete();
    const [requestId] = evidence.requests;
    return requestId === undefined ? null : { evidence, requestId };
  };

  return {
    prompting: (plan) => (...args) => {
      const base = plan(...args);
      return {
        ...base,
        gate: (request) => {
          const refused = base.gate(request);
          if (refused === null) { startBaseline(); }
          return refused;
        },
        onReply: (reply) => {
          const body = base.onReply(reply);
          if (body.kind === "rejected") { baseline = null; }
          return body;
        },
        onError: (message, native) => {
          baseline = null;
          return base.onError(message, native);
        },
      };
    },
    aborting: (plan) => () => {
      const base = plan();
      let issued: RequestRecord | null = null;
      return {
        ...base,
        gate: (request) => {
          issued = request;
          return base.gate(request);
        },
        prepare: async () => {
          const ends = turnEnds;
          observing ??= observe(base.params().turnId);
          const window = observing;
          const evidence = await window;
          const unreachable = kernel.unreachable();
          if (unreachable !== null || ends !== turnEnds || issued === null) {
            evidence.cancellation.complete();
            if (observing === window) { observing = null; }
            return unreachable ?? { kind: "rejected", code: "no_active_turn", reason: "turn ended before the interrupt was sent" };
          }
          evidence.cancellation.commit();
          evidence.requests.add(issued.id);
          sent = evidence;
          return null;
        },
        onError: (message, native) => {
          if (issued !== null && sent?.requests.delete(issued.id) === true && sent.requests.size === 0) {
            sent.cancellation.complete();
            sent = null;
            observing = null;
          }
          return base.onError(message, native);
        },
      };
    },
    turnCompleted(params) {
      const closed = closeTurn();
      if (closed !== null) { decide(closed.requestId, closed.evidence, asRecord(params.turn)); }
    },
    exited() {
      const closed = closeTurn();
      if (closed !== null) { record(closed.requestId, { kind: "failed", reason: "the app-server exited before the aborted turn ended; its exit cleanup applies instead" }); }
    },
    async settled() { await Promise.all(ending); },
  };
}
