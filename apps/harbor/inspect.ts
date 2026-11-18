import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eventsOf, type Event, type RawEvent } from "../../packages/oar/src/index.js";
import type { AgentStatusLine } from "./support.js";
import { readJsonl, type JournalEntry, type Store } from "./store.js";

/** Read-only views a QA agent uses; none needs the daemon except `status`, whose lines it passes in. */

export function read(store: Store, after: number, limit: number): void {
  const messages = store.messages().filter((message) => message.seq > after);
  for (const message of messages.slice(-limit)) {
    const to = message.to.map((name) => `@${name}`).join(" ");
    console.log(`[msg=${message.seq} ${new Date(message.at).toISOString()} @${message.from} → ${to === "" ? "-" : to}]\n${message.text}\n`);
  }
}

export function printStatus(lines: readonly AgentStatusLine[]): void {
  for (const line of lines) {
    const state = line.forMs === null ? line.state : `${line.state} ${seconds(line.forMs)}`;
    const context = line.contextPercent === null ? "ctx ?" : `ctx ${line.contextPercent.toFixed(0)}%`;
    const tokens = line.tokens === null ? "tok ?" : `tok ${line.tokens.input}/${line.tokens.output}`;
    const waiting = line.awaitingReply ? "; awaiting reply" : "";
    console.log(`@${line.name} (${line.runtime}${line.model === null ? "" : ` ${line.model}`}): ${state}; turns ${line.turns}, last ${line.lastOutcome ?? "-"}; ${context}; ${tokens}; pending ${line.pending}${waiting}; session ${line.sessionId ?? "-"} (opens ${line.opens})`);
  }
}

export async function watch(store: Store, all: boolean): Promise<void> {
  let seen = store.entries().length;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
    const entries = store.entries();
    for (const entry of entries.slice(seen)) {
      if (all || entry.kind === "finding") {
        console.log(formatEntry(entry));
      }
    }
    seen = entries.length;
  }
}

export function formatEntry(entry: JournalEntry): string {
  const { at, agent, kind, ...rest } = entry;
  return `${new Date(at).toISOString()} ${agent === undefined ? "" : `@${agent} `}${kind} ${JSON.stringify(rest)}`;
}

export interface TraceOptions {
  readonly turn?: number;
  readonly around?: number;
  readonly session?: number;
  /** A run-relative voyage path, as findings name it; overrides agent and session. */
  readonly voyage?: string;
  readonly raw: boolean;
}

/**
 * One turn (default: the latest) or the records around a seq, from one voyage
 * log: native frames with OAR's reading of each. Turns are the root session's
 * `turn_started` / `turn_active` boundaries, numbered per session, as the
 * journal numbers them.
 */
export function trace(store: Store, agent: string, options: TraceOptions): void {
  const file = voyageFile(store, agent, options);
  const lines = readJsonl<{ kind: string; record?: RawEvent; sessionId?: string }>(file);
  const root = lines[0]?.sessionId;
  const records = lines.flatMap((line) => (line.kind === "record" && line.record !== undefined ? [line.record] : []));
  const turns: number[] = [];
  let open = false;
  for (const [index, record] of records.entries()) {
    if (record.sessionId !== root || record.agentPath.length > 0) {
      continue;
    }
    for (const event of eventsOf(record)) {
      if (event.kind === "turn_started" || (event.kind === "turn_active" && !open)) {
        turns.push(index);
        open = true;
      } else if (event.kind === "turn_ended") {
        open = false;
      }
    }
  }
  const [from, to] = range(records, turns, options);
  if (options.around === undefined && turns.length > 0) {
    console.log(`turn ${turns.indexOf(from) + 1} of ${turns.length} in ${file}`);
  }
  const start = records[from]?.receivedAt ?? 0;
  for (const record of records.slice(from, to)) {
    if (options.raw) {
      console.log(JSON.stringify(record));
      continue;
    }
    const events = eventsOf(record).map((event) => `\n    ${describeEvent(event)}`).join("");
    console.log(`#${record.seq} +${seconds(record.receivedAt - start)} ${describe(record)}${events}`);
  }
  console.log(`(native records: --raw, or ${file})`);
}

function voyageFile(store: Store, agent: string, options: TraceOptions): string {
  if (options.voyage !== undefined) {
    const file = join(store.dir, options.voyage);
    if (!existsSync(file)) {
      throw new Error(`no voyage log ${options.voyage}`);
    }
    return file;
  }
  const agentDir = join(store.dir, "agents", agent);
  if (agent === "" || !existsSync(agentDir)) {
    throw new Error(`no agent ${agent}`);
  }
  const latest = readdirSync(agentDir)
    .filter((name) => name.endsWith(".voyage.jsonl"))
    .toSorted((a, b) => statSync(join(agentDir, a)).mtimeMs - statSync(join(agentDir, b)).mtimeMs)
    .at(-1);
  const file = options.session === undefined ? latest : `session-${options.session}.voyage.jsonl`;
  if (file === undefined || !existsSync(join(agentDir, file))) {
    throw new Error(`no voyage log for ${agent}`);
  }
  return join(agentDir, file);
}

function range(records: readonly RawEvent[], turns: readonly number[], options: TraceOptions): [number, number] {
  if (options.around !== undefined) {
    const target = options.around;
    const at = records.findIndex((record) => record.seq === target);
    if (at === -1) {
      throw new Error(`seq ${target} is not in this voyage (seqs ${records[0]?.seq ?? "-"} to ${records.at(-1)?.seq ?? "-"})`);
    }
    return [Math.max(0, at - 15), Math.min(records.length, at + 16)];
  }
  if (turns.length === 0) {
    return [0, records.length];
  }
  const turn = Math.min(Math.max(options.turn ?? turns.length, 1), turns.length);
  return [turns[turn - 1] ?? 0, turns[turn] ?? records.length];
}

function describe(record: RawEvent): string {
  const path = record.agentPath.length === 0 ? "" : ` [${record.agentPath.join("/")}]`;
  if (record.kind === "frame") {
    return `frame ${record.body.type}${path}`;
  }
  if (record.kind === "request") {
    return `request ${record.direction} ${clip(JSON.stringify(record.body), 160)}${path}`;
  }
  return `response ${clip(JSON.stringify(record.body), 160)}${path}`;
}

function describeEvent(event: Event): string {
  if (event.kind === "text_delta") {
    return `text ${clip(JSON.stringify(event.text), 200)}`;
  }
  if (event.kind === "tool_call_started") {
    return `tool ${event.tool}`;
  }
  if (event.kind === "tool_call_ended") {
    return `tool ended ${event.result ?? ""}${event.exitCode === undefined ? "" : ` exit ${String(event.exitCode)}`}`;
  }
  if (event.kind === "turn_ended") {
    return `turn_ended ${event.outcome.kind}${event.outcome.kind === "failed" ? `: ${event.outcome.reason}` : ""}`;
  }
  return event.kind;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
