import { claudeModelRequestRefusal } from "./options.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions, TurnOutcome } from "../../contracts/session.js";
import { watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelRequest } from "../../contracts/model-request.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { privateTempDir } from "../../shared/private-temp.js";
import { claudeSyntheticAssistant } from "./failure.js";
import { attribution, pruneCaptures, readAttributed, readIndex, type AttributedRequest } from "./model-request-files.js";

const ATTRIBUTION_MS = 2000;

/** The index joins an answered root message to its body. A request file on its own carries no attribution. */
export interface ClaudeModelRequests {
  readonly setting: string;
  setProvider(this: void, value: string): void;
  observe(this: void, message: JsonRecord): void;
  ended(this: void, outcome: TurnOutcome): void;
  read(this: void): Promise<ModelRequest | null>;
  close(this: void): void;
  remove(this: void): void;
}

export async function openClaudeModelRequests(sessionId: string, options: SessionOptions, version?: string): Promise<ClaudeModelRequests | undefined> {
  if (options.modelRequests === undefined) { return undefined; }
  const refusal = claudeModelRequestRefusal(version).modelRequests;
  if (refusal !== undefined) { throw new UnsupportedOptionError("modelRequests", refusal); }
  const capture = await claudeModelRequests(sessionId);
  return capture;
}

export async function claudeModelRequests(sessionId: string, waitMs = ATTRIBUTION_MS): Promise<ClaudeModelRequests> {
  const directory = await privateTempDir("oar-claude-requests-");
  const pending = new Map<string, { turn: number; at: number }>();
  let provider: string | undefined = undefined;
  let turn = 0;
  let offset = 0;
  let latest: AttributedRequest | null = null;
  let latestObserved = false;
  let closed = false;
  const isClosed = (): boolean => closed;
  let updating: Promise<void> | undefined = undefined;
  const retired = new Set<string>();
  const retire = (entry: AttributedRequest): void => {
    if (entry.request !== undefined) { retired.add(entry.request); }
    retired.add(entry.response);
  };
  const update = async (): Promise<void> => {
    if (isClosed()) { return; }
    const batch = await readIndex(directory.path, offset).catch((error: unknown) => {
      if (asRecord(error)?.code === "ENOENT") { return { rows: [], offset }; }
      throw new Error("Claude's request index could not be read");
    });
    if (isClosed()) { return; }
    for (const row of batch.rows) {
      const entry = attribution(row);
      if (entry === null) { continue; }
      if (row.session_id !== sessionId || row.query_source !== "sdk") { retire(entry); continue; }
      if (latest?.id === entry.id) { continue; }
      if (latest !== null && entry.indexedAt < latest.indexedAt) {
        pending.delete(entry.id);
        retire(entry);
        continue;
      }
      if (latest !== null) { retire(latest); }
      latest = entry;
      latestObserved = pending.has(entry.id);
      if (latestObserved) {
        for (const id of pending.keys()) {
          pending.delete(id);
          if (id === entry.id) { break; }
        }
      }
    }
    offset = batch.offset;
    if (batch.rows.length > 0 || retired.size > 0) {
      await pruneCaptures(directory.path, retired, latest);
      retired.clear();
    }
  };
  const refresh = async (): Promise<void> => {
    if (updating !== undefined) { await updating; }
    updating ??= update();
    const work = updating;
    try { await work; } finally { if (updating === work) { updating = undefined; } }
  };
  const maintain = async (): Promise<void> => {
    try { await refresh(); } catch { /* A foreground read retries and reports failures. */ }
  };
  // Cleanup runs even when a host never opens View Context. A read always checks the index independently.
  const watcher = watch(directory.path, { persistent: false }, (_event, name) => {
    if (name === "index.jsonl" || name === null) { void maintain(); }
  });
  watcher.on("error", () => { watcher.close(); });
  const close = (): void => { closed = true; pending.clear(); watcher.close(); };
  return {
    setting: `file:${directory.path}`,
    setProvider(value: string): void { provider = value; },
    observe(message: JsonRecord): void {
      if (closed || message.type !== "assistant" || message.session_id !== sessionId || typeof message.parent_tool_use_id === "string" || claudeSyntheticAssistant(message)) { return; }
      const id = asRecord(message.message)?.id;
      if (typeof id !== "string") { return; }
      if (latest?.id === id) {
        if (!latestObserved) { pending.clear(); latestObserved = true; }
      }
      else if (!pending.has(id)) { pending.set(id, { turn, at: performance.now() }); }
    },
    ended(outcome: TurnOutcome): void {
      if (outcome.kind === "aborted" || outcome.kind === "failed") {
        for (const [id, wait] of pending) { if (wait.turn === turn) { pending.delete(id); } }
      }
      turn += 1;
    },
    async read(): Promise<ModelRequest | null> {
      const start = performance.now();
      while (!isClosed()) {
        try { await refresh(); } catch {
          if (isClosed()) { return null; }
          throw new Error("Claude's model request capture could not be read");
        }
        if (isClosed()) { return null; }
        const wait = [...pending.values()].at(-1);
        if (wait === undefined) {
          const entry = latest;
          if (entry === null) { return null; }
          // The native writer does not rename atomically. Never return a partly written body.
          const result = await readAttributed(directory.path, entry).catch(() => null);
          if (isClosed()) { return null; }
          if (latest === entry && pending.size === 0 && result !== null) { return provider === undefined ? result : { ...result, provider }; }
        }
        if (performance.now() - (wait?.at ?? start) >= waitMs) {
          throw new Error(`Claude did not provide a complete attributed root model request within ${String(waitMs)} ms`);
        }
        await delay(10);
      }
      return null;
    },
    close,
    remove(): void { close(); directory.remove(); },
  };
}
