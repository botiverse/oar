/**
 * GROK RAW WIRE TAP: every JSON-RPC line between OAR and the real
 * `grok agent stdio` binary, both directions, versus what reached the record
 * stream.
 *
 * Why: the ACP SDK (1.4.0) routes only registered notification methods, and
 * its client app parses every `session/update` with a CLOSED zod union of
 * the 15 standard `sessionUpdate` kinds BEFORE any app handler runs
 * (`client-session-update-router`); an unknown kind throws, the SDK logs
 * "Error handling notification" on OAR's stderr and the frame never reaches
 * the adapter. Only a tap BELOW the SDK shows what grok really sends: which
 * vendor notification methods, which `sessionUpdate` kinds on `session/update`
 * and on `_x.ai/session_notification`, and which of them the stream is
 * missing.
 *
 * How: a shim executable (pinned through OAR_GROK_BIN, see
 * packages/oar/src/runtimes/grok/installation.ts) forwards stdin/stdout to the
 * real binary line by line and appends `{t, dir, line}` to GROK_TAP_LOG. Live
 * mode runs two prompts from a scratch cwd under /tmp (yolo mode is selected
 * by the profile): a one-word reply and a `spawn_subagent` delegation. Offline
 * mode (`--tap-log <file> --voyage <file>...`) tallies an existing tap log
 * (e.g. one written while experiments/live-contract.ts ran through the shim)
 * against the oar-voyage/2 logs of the same run.
 *
 * Run: pnpm tsx experiments/grok-wire-tap.ts [--keep] [--skip-subagent]
 *      pnpm tsx experiments/grok-wire-tap.ts --tap-log wire.jsonl --voyage a.voyage.jsonl [--voyage b.voyage.jsonl]
 * Live mode burns tokens for two grok turns (the sub-agent one is the
 * expensive one). `--keep` leaves the tap log and scratch directory in place.
 *
 * ── OBSERVED 2026-09-11, grok 1.0.25 (f7e67d6988e2), darwin arm64 ──
 *
 * Two tapped runs of experiments/live-contract.ts through the shim
 * (oar-trial-run/live-grok-tap: basic + subagent, before the adapter fixes;
 * live-grok-tap2: basic + multi-turn + subagent, after), tallied offline.
 *
 * Inbound (agent→app) notifications: `session/update` carried ONLY standard
 * kinds (`available_commands_update`, `session_info_update`,
 * `agent_thought_chunk`, `agent_message_chunk`, `user_message_chunk`,
 * `tool_call`, `tool_call_update`), for the root and for each child session
 * id alike, so the SDK's closed-union parse dropped nothing.
 * `_x.ai/session_notification` has the same envelope shape
 * `{sessionId, update:{sessionUpdate}}` and is where every vendor kind
 * travels: `model_changed`, `session_summary_generated`,
 * `tool_call_delta_chunk`, `pending_interaction`, `interaction_resolved`,
 * `response_completed`, `turn_completed`, `last_turn_summary`,
 * `background_tasks` (on session/resume), `subagent_spawned`,
 * `subagent_progress`, `subagent_finished`. Also on the wire:
 * `_x.ai/sessions/changed`, `_x.ai/session/prompt_complete`, and per
 * session start `_x.ai/queue/changed`, `_x.ai/models/update`,
 * `_x.ai/settings/update`, `_x.ai/announcements/update`,
 * `_x.ai/mcp/servers_updated`, `_x.ai/mcp/init_progress`,
 * `_x.ai/mcp/server_status`, `_x.ai/mcp_initialized`: those eight were
 * MISSING from the stream in the first run (not in
 * GROK_EXTENSION_NOTIFICATIONS, so the SDK discarded them unseen) and
 * present with matching counts in the second, after they were listed.
 * Inbound requests: `terminal/create|wait_for_exit|output|release`; with
 * `--always-approve` no `session/request_permission`. No unsolicited
 * response in either tapped run (the "skills-reload" response the SDK
 * complained about in the untapped first battery chunk did not recur).
 *
 * The sub-agent lineage is `_x.ai/session_notification {sessionId:
 * <parent>, update: {sessionUpdate: "subagent_spawned", parent_session_id,
 * child_session_id, subagent_type, subagent_id, attempt_id,
 * parent_prompt_id, model, ...}}` (snake_case, nested under `update`);
 * `subagent_finished` names only `child_session_id` under the parent's
 * envelope. The adapter's graph edge (via "tool_call") appeared only after
 * records.ts learned that spelling; `graph().edges` was `[]` in the first
 * run and one parent→child edge in the second.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grokRuntime, promptAndWait, type SessionRecord } from "../packages/oar/src/index.js";
import { asRecord, parseJson, type JsonRecord } from "../packages/oar/src/shared/json.js";

// ─── arguments ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const skipSubagent = argv.includes("--skip-subagent");
function flags(name: string): string[] {
  const values: string[] = [];
  argv.forEach((part, index) => {
    const next = argv[index + 1];
    if (part === name && next !== undefined) {
      values.push(next);
    }
  });
  return values;
}
const [offlineTapLog] = flags("--tap-log");
const offlineVoyages = flags("--voyage");

// ─── tally ────────────────────────────────────────────────────────────────

type Tally = Record<string, number>;
function bump(tally: Tally, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

interface WireTally {
  readonly inboundNotifications: Tally;
  readonly inboundRequests: Tally;
  inboundResponses: number;
  /** Responses whose id no outbound request carried (grok's `skills-reload`). */
  readonly unsolicitedResponses: string[];
  readonly outboundRequests: Tally;
  readonly outboundNotifications: Tally;
  outboundResponses: number;
  /** `session/update` → `update.sessionUpdate` counts. */
  readonly sessionUpdates: Tally;
  /** `_x.ai/session_notification` → `update.sessionUpdate` counts. */
  readonly vendorUpdates: Tally;
  /** Session ids named by any inbound notification, in first-seen order. */
  readonly sessionIds: string[];
  /** Frames whose JSON names a parent/child session pair, verbatim (first 6). */
  readonly linkageFrames: string[];
  nonJson: number;
}

const LINKAGE = /parent_session_id|parentSessionId|child_session_id|childSessionId|subagent_spawned|subagent_finished/u;

export function tallyWire(lines: readonly string[]): WireTally {
  const wire: WireTally = {
    inboundNotifications: {},
    inboundRequests: {},
    inboundResponses: 0,
    unsolicitedResponses: [],
    outboundRequests: {},
    outboundNotifications: {},
    outboundResponses: 0,
    sessionUpdates: {},
    vendorUpdates: {},
    sessionIds: [],
    linkageFrames: [],
    nonJson: 0,
  };
  const outboundIds = new Set<string>();
  const entries = lines
    .map((raw) => asRecord(parseJson(raw)))
    .filter((entry): entry is JsonRecord => entry !== null && typeof entry.line === "string" && entry.dir !== "exit");
  for (const entry of entries) {
    const line = typeof entry.line === "string" ? entry.line : "";
    const frame = asRecord(parseJson(line));
    if (frame === null) {
      wire.nonJson += 1;
    } else {
      tallyFrame(wire, outboundIds, { inbound: entry.dir === "agent->app", line, frame });
    }
  }
  return wire;
}

function tallyFrame(
  wire: WireTally,
  outboundIds: Set<string>,
  { inbound, line, frame }: { readonly inbound: boolean; readonly line: string; readonly frame: JsonRecord },
): void {
  const method = typeof frame.method === "string" ? frame.method : null;
  const hasId = frame.id !== undefined;
  const id = hasId ? JSON.stringify(frame.id) : null;
  if (inbound) {
      if (method === null) {
        wire.inboundResponses += 1;
        if (id !== null && !outboundIds.has(id)) {
          wire.unsolicitedResponses.push(id);
        }
      } else if (hasId) {
        bump(wire.inboundRequests, method);
      } else {
        bump(wire.inboundNotifications, method);
        const params = asRecord(frame.params);
        const update = asRecord(params?.update);
        const kind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null;
        if (kind !== null) {
          bump(method === "session/update" ? wire.sessionUpdates : wire.vendorUpdates, `${method === "session/update" ? "" : `${method} `}${kind}`);
        }
        const sessionId = params?.sessionId;
        if (typeof sessionId === "string" && !wire.sessionIds.includes(sessionId)) {
          wire.sessionIds.push(sessionId);
        }
        if (LINKAGE.test(line) && wire.linkageFrames.length < 6) {
          wire.linkageFrames.push(line.slice(0, 600));
        }
      }
    } else if (method === null) {
      wire.outboundResponses += 1;
    } else if (hasId) {
      if (id !== null) {
        outboundIds.add(id);
      }
      bump(wire.outboundRequests, method);
    } else {
      bump(wire.outboundNotifications, method);
    }
}

interface StreamTally {
  readonly eventTypes: Tally;
  /** Event types keyed by the record's envelope session id (root vs derived child). */
  readonly eventTypesBySession: Tally;
  readonly toAppRequests: Tally;
  toAppAnswers: number;
  readonly sessionIds: string[];
}

export function tallyStream(records: readonly SessionRecord[]): StreamTally {
  const stream: StreamTally = { eventTypes: {}, eventTypesBySession: {}, toAppRequests: {}, toAppAnswers: 0, sessionIds: [] };
  for (const record of records) {
    if (!stream.sessionIds.includes(record.sessionId)) {
      stream.sessionIds.push(record.sessionId);
    }
    if (record.kind === "event") {
      bump(stream.eventTypes, record.body.type);
      bump(stream.eventTypesBySession, `${record.sessionId.slice(0, 8)} ${record.body.type}`);
    } else if (record.kind === "request" && record.direction === "toApp" && record.body.kind === "native") {
      bump(stream.toAppRequests, record.body.type);
    } else if (record.kind === "response" && record.body.kind === "answered") {
      stream.toAppAnswers += 1;
    }
  }
  return stream;
}

/**
 * Every wire `session/update` kind must be an event type with the same count
 * (the adapter types the record by `sessionUpdate`); every other inbound
 * notification method an event type with the same count (a vendor method is
 * recorded under the METHOD name, whatever kinds it carries); every inbound
 * request a toApp record.
 */
export function diffWireAgainstStream(wire: WireTally, stream: StreamTally): string[] {
  const missing: string[] = [];
  for (const [kind, count] of Object.entries(wire.sessionUpdates)) {
    if ((stream.eventTypes[kind] ?? 0) !== count) {
      missing.push(`session/update ${kind}: wire ${String(count)} vs stream ${String(stream.eventTypes[kind] ?? 0)}`);
    }
  }
  for (const [method, count] of Object.entries(wire.inboundNotifications)) {
    if (method !== "session/update" && (stream.eventTypes[method] ?? 0) !== count) {
      missing.push(`notification ${method}: wire ${String(count)} vs stream ${String(stream.eventTypes[method] ?? 0)} (not in profile.extensionNotifications?)`);
    }
  }
  for (const [method, count] of Object.entries(wire.inboundRequests)) {
    if ((stream.toAppRequests[method] ?? 0) !== count) {
      missing.push(`request ${method}: wire ${String(count)} vs stream ${String(stream.toAppRequests[method] ?? 0)}`);
    }
  }
  return missing;
}

function readVoyageRecords(file: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n").filter((part) => part.length > 0)) {
    const entry = asRecord(parseJson(line));
    if (entry?.kind === "record") {
      // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- an oar-voyage/2 line is a stamped record.
      records.push(entry.record as SessionRecord);
    }
  }
  return records;
}

function emit(report: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// ─── offline mode ─────────────────────────────────────────────────────────

if (offlineTapLog !== undefined) {
  const wire = tallyWire(readFileSync(offlineTapLog, "utf8").split("\n"));
  const stream = tallyStream(offlineVoyages.flatMap((file) => readVoyageRecords(file)));
  const missing = diffWireAgainstStream(wire, stream);
  emit({ tapLog: offlineTapLog, voyages: offlineVoyages, wire, stream, missingFromStream: missing });
  process.exit(missing.length === 0 ? 0 : 1);
}

// ─── live mode ────────────────────────────────────────────────────────────

const scratch = mkdtempSync(path.join(tmpdir(), "oar-grok-tap-"));
const real = process.env.GROK_TAP_REAL ?? path.join(process.env.HOME ?? "", ".grok", "bin", "grok");
const tapLog = path.join(scratch, "wire.jsonl");
const tapScript = path.join(scratch, "grok-tap.mjs");
const shim = path.join(scratch, "grok");

writeFileSync(tapScript, `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.GROK_TAP_LOG;
const child = spawn(${JSON.stringify(real)}, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
const write = (dir, line) => { if (log) appendFileSync(log, JSON.stringify({ t: Date.now(), dir, line }) + "\\n"); };
createInterface({ input: process.stdin }).on("line", (line) => { write("app->agent", line); child.stdin.write(line + "\\n"); });
process.stdin.on("end", () => child.stdin.end());
createInterface({ input: child.stdout }).on("line", (line) => { write("agent->app", line); process.stdout.write(line + "\\n"); });
child.on("exit", (code, signal) => { write("exit", String(code) + " " + String(signal)); process.exit(code ?? 1); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
`);
writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(tapScript)} "$@"\n`, { mode: 0o755 });

process.env.OAR_GROK_BIN = shim;
const installation = await grokRuntime.installation();
assert.ok(installation.kind === "available", "grok is not available through the tap shim");
// The probe above ran `agent stdio --help` / `--version` through the shim untapped; tap only the sessions.
process.env.GROK_TAP_LOG = tapLog;

const prompts = [
  "Reply with exactly the word PLUM and nothing else.",
  ...(skipSubagent ? [] : [
    "Use your task tool (spawn_subagent) with subagent_type general-purpose and run_in_background false to launch exactly one sub-agent whose only job is to run the shell command `echo CHILD-OK-7731` and report the printed line back to you. Do not run the command yourself. When it reports back, reply with exactly the line it reported.",
  ]),
];
const outcomes: unknown[] = [];
const records: SessionRecord[] = [];
const graphs: unknown[] = [];
for (const prompt of prompts) {
  // eslint-disable-next-line no-await-in-loop
  const session = await grokRuntime.session(installation, { cwd: scratch });
  // eslint-disable-next-line no-await-in-loop
  const run = await promptAndWait(session, prompt);
  assert.equal(run.kind, "ended", "prompt was not accepted");
  outcomes.push(run.outcome);
  // eslint-disable-next-line no-await-in-loop
  await session.dispose();
  records.push(...session.records());
  graphs.push(session.graph());
}

const wire = tallyWire(readFileSync(tapLog, "utf8").split("\n"));
const stream = tallyStream(records);
const missing = diffWireAgainstStream(wire, stream);
emit({
  version: installation.via === "executable" ? (installation.version ?? null) : null,
  outcomes,
  graphs,
  wire,
  stream,
  missingFromStream: missing,
  ...(keep ? { tapLog, scratch } : {}),
});
if (!keep) {
  rmSync(scratch, { recursive: true, force: true });
}
assert.deepEqual(missing, [], "frames on the wire did not all reach the record stream");
