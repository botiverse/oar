/**
 * KIMI RAW WIRE TAP: every JSON-RPC line between OAR and the real `kimi acp`
 * binary, both directions, versus what reached the record stream.
 *
 * Why: the adapter records every `session/update` verbatim and lists the
 * vendor extension notifications it subscribes to (none for kimi). Only a tap
 * BELOW the SDK can show whether the runtime sends frames OAR never sees:
 * an unregistered notification method, a request OAR does not handle, or a
 * `sessionUpdate` kind that yields no view.
 *
 * How: a shim executable (pinned through OAR_KIMI_BIN, see
 * packages/oar/src/runtimes/kimi/installation.ts) forwards stdin/stdout to the
 * real binary line by line and appends `{t, dir, line}` to KIMI_TAP_LOG. One
 * session runs one shell-tool prompt from a scratch cwd under /tmp (yolo mode
 * is selected by the profile). The script then tallies, per direction, every
 * method / `sessionUpdate` kind on the wire against the record stream.
 *
 * Run: pnpm tsx experiments/kimi-wire-tap.ts [--keep]
 * Burns tokens for one short kimi turn. `--keep` leaves the tap log and
 * scratch directory in place (paths are printed).
 *
 * ── OBSERVED 2026-09-11, kimi 0.42.0, darwin arm64, default model kimi-code/k3 ──
 *
 * Outbound (app→agent): `initialize`, `authenticate`, `session/new`,
 * `session/set_mode` (the profile's yolo selection), `session/prompt`,
 * `session/close` (dispose): six requests, all six answered (`inboundResponses:
 * 6`; `session/close` answers `{}` before the kill), and four responses to the
 * agent's requests. No outbound notification (no cancel in this run).
 * Inbound (agent→app): 49 `session/update` notifications and four requests:
 * `terminal/create`, `terminal/wait_for_exit`, `terminal/output`,
 * `terminal/release`, one each. No vendor extension notification, no
 * `session/request_permission` (yolo). `sessionUpdate` kinds on the wire, each
 * reaching the stream as one event record with the same count:
 * `available_commands_update` 1, `current_mode_update` 1,
 * `config_option_update` 1, `session_info_update` 1 (all viewless),
 * `agent_thought_chunk` 22, `tool_call` 1, `tool_call_update` 14,
 * `agent_message_chunk` 7, `usage_update` 1 (with views). Every inbound
 * request is a `toApp` request record with its answer. `missingFromStream: []`.
 * The `session/set_mode` and `session/close` answers are the only inbound
 * frames with no record of their own (the profile's own bookkeeping calls).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { kimiRuntime, promptAndWait } from "../packages/oar/src/index.js";
import { asRecord, parseJson, type JsonRecord } from "../packages/oar/src/shared/json.js";

const keep = process.argv.includes("--keep");
const scratch = mkdtempSync(path.join(tmpdir(), "oar-kimi-tap-"));
const real = process.env.KIMI_TAP_REAL ?? path.join(process.env.HOME ?? "", ".kimi-code", "bin", "kimi");
const tapLog = path.join(scratch, "wire.jsonl");
const tapScript = path.join(scratch, "kimi-tap.mjs");
const shim = path.join(scratch, "kimi");

writeFileSync(tapScript, `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.KIMI_TAP_LOG;
const child = spawn(${JSON.stringify(real)}, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"] });
const write = (dir, line) => { if (log) appendFileSync(log, JSON.stringify({ t: Date.now(), dir, line }) + "\\n"); };
createInterface({ input: process.stdin }).on("line", (line) => { write("app->agent", line); child.stdin.write(line + "\\n"); });
process.stdin.on("end", () => child.stdin.end());
createInterface({ input: child.stdout }).on("line", (line) => { write("agent->app", line); process.stdout.write(line + "\\n"); });
child.on("exit", (code, signal) => { write("exit", String(code) + " " + String(signal)); process.exit(code ?? 1); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
`);
writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(tapScript)} "$@"\n`, { mode: 0o755 });

process.env.OAR_KIMI_BIN = shim;
const installation = await kimiRuntime.installation();
assert.ok(installation.kind === "available", "kimi is not available through the tap shim");
// The probe above ran `acp --help` / `--version` through the shim untapped; tap only the session.
process.env.KIMI_TAP_LOG = tapLog;

const session = await kimiRuntime.session(installation, { cwd: scratch });
const run = await promptAndWait(session, "Use your shell tool to run exactly: echo TAP-MARK-9001. Then reply with exactly the printed line.");
assert.ok(run.kind === "ended", "prompt was not accepted");
await session.dispose();

// ─── tally ────────────────────────────────────────────────────────────────

type Tally = Record<string, number>;
function bump(tally: Tally, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

interface WireTally {
  readonly inboundNotifications: Tally;
  readonly inboundRequests: Tally;
  inboundResponses: number;
  readonly outboundRequests: Tally;
  readonly outboundNotifications: Tally;
  outboundResponses: number;
  readonly sessionUpdates: Tally;
  nonJson: number;
}

const wire: WireTally = { inboundNotifications: {}, inboundRequests: {}, inboundResponses: 0, outboundRequests: {}, outboundNotifications: {}, outboundResponses: 0, sessionUpdates: {}, nonJson: 0 };

function tallyInbound(frame: JsonRecord): void {
  const method = typeof frame.method === "string" ? frame.method : null;
  if (method === null) {
    wire.inboundResponses += 1;
  } else if (frame.id === undefined) {
    bump(wire.inboundNotifications, method);
    const update = asRecord(asRecord(frame.params)?.update);
    if (method === "session/update" && typeof update?.sessionUpdate === "string") {
      bump(wire.sessionUpdates, update.sessionUpdate);
    }
  } else {
    bump(wire.inboundRequests, method);
  }
}

function tallyOutbound(frame: JsonRecord): void {
  const method = typeof frame.method === "string" ? frame.method : null;
  if (method === null) {
    wire.outboundResponses += 1;
  } else if (frame.id === undefined) {
    bump(wire.outboundNotifications, method);
  } else {
    bump(wire.outboundRequests, method);
  }
}

for (const raw of readFileSync(tapLog, "utf8").split("\n").filter((line) => line.length > 0)) {
  const entry = asRecord(parseJson(raw));
  if (entry !== null && typeof entry.line === "string" && entry.dir !== "exit") {
    const frame = asRecord(parseJson(entry.line));
    if (frame === null) {
      wire.nonJson += 1;
    } else if (entry.dir === "agent->app") {
      tallyInbound(frame);
    } else {
      tallyOutbound(frame);
    }
  }
}

const stream: { readonly eventTypes: Tally; readonly toAppRequests: Tally; toAppAnswers: number } = { eventTypes: {}, toAppRequests: {}, toAppAnswers: 0 };
for (const record of session.records()) {
  if (record.kind === "event") {
    bump(stream.eventTypes, record.body.type);
  } else if (record.kind === "request" && record.direction === "toApp" && record.body.kind === "native") {
    bump(stream.toAppRequests, record.body.type);
  } else if (record.kind === "response" && record.body.kind === "answered") {
    stream.toAppAnswers += 1;
  }
}

// Every wire sessionUpdate kind must be an event type with the same count; every inbound request a toApp record.
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

const report: JsonRecord = {
  version: installation.via === "executable" ? (installation.version ?? null) : null,
  outcome: run.outcome,
  wire,
  stream,
  missingFromStream: missing,
  ...(keep ? { tapLog, scratch } : {}),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!keep) {
  rmSync(scratch, { recursive: true, force: true });
}
assert.deepEqual(missing, [], "frames on the wire did not all reach the record stream");
