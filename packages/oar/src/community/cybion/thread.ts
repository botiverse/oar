import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { FailureClass } from "../../contracts/failure.js";
import { SessionNotFoundError } from "../../contracts/session-not-found-error.js";
import type { ResponseBody, SessionOptions } from "../../contracts/session.js";
import { asNumber, asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { errorText, type CybionClient } from "./client.js";
import { CybionRefusalError, replyMessage } from "./refusal.js";

/** The parts of a Cybion Thread (`ThreadView`) this adapter reads. */
export interface CybionThread {
  /** The `ThreadView` as Cybion sent it, kept verbatim for the frame that carries it. */
  readonly native: unknown;
  readonly id: string;
  /** `running` while a turn runs; `idle` or `failed` otherwise. */
  readonly status: string;
  /** The refined idle meaning: `ready`, `completed`, `stopped`, `blocked` or `compacting`. */
  readonly displayStatus: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Input tokens of the most recent inference, Cybion's own context fullness figure. */
  readonly contextTokens: number | null;
  readonly usage: CybionUsage;
}

/** A Thread's settled token totals, counted by Cybion since it was created. */
export interface CybionUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

/** One record of a Thread's append-only history (`GET /v1/threads/{id}/history`). */
export interface CybionHistoryRecord {
  /** The record as Cybion sent it, kept verbatim for the frame that carries it. */
  readonly native: unknown;
  readonly id: number;
  readonly kind: string;
  readonly payload: JsonRecord;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function usageOf(value: unknown): CybionUsage {
  const usage = asRecord(value);
  return {
    input: asNumber(usage?.input_tokens) ?? 0,
    output: asNumber(usage?.output_tokens) ?? 0,
    cacheRead: asNumber(usage?.cached_tokens) ?? 0,
  };
}

/** A `ThreadView` read into the facts this adapter uses; a body without an id is not a Thread. */
export function threadOf(value: unknown): CybionThread {
  const thread = asRecord(value);
  const id = text(thread?.id);
  if (thread === null || id === null) {
    throw new Error("Cybion answered without a Thread id");
  }
  return {
    native: value,
    id,
    status: text(thread.status) ?? "idle",
    displayStatus: text(thread.display_status) ?? "ready",
    title: text(thread.title),
    model: text(thread.model),
    effort: text(thread.reasoning_effort),
    contextTokens: asNumber(thread.context_tokens),
    usage: usageOf(thread.usage),
  };
}

/** A Thread's history in record order, read into the fields this adapter maps. */
export function historyOf(value: unknown): CybionHistoryRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: unknown[] = value;
  const records: CybionHistoryRecord[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = asNumber(record?.id);
    const kind = text(record?.kind);
    if (record === null || id === null || kind === null) {
      continue;
    }
    records.push({ native: entry, id, kind, payload: asRecord(record.payload) ?? {} });
  }
  return records;
}

/** Read one Thread, or fail with what Cybion answered. */
export async function readThread(client: CybionClient, threadId: string): Promise<CybionThread> {
  return threadOf(await client.expect("GET", `/v1/threads/${encodeURIComponent(threadId)}`));
}

/** The Thread's whole history, oldest first. */
export async function readHistory(client: CybionClient, threadId: string): Promise<CybionHistoryRecord[]> {
  return historyOf(await client.expect("GET", `/v1/threads/${encodeURIComponent(threadId)}/history`));
}

/** The last history record a Thread holds, so a session's stream starts at its own first turn. */
export async function lastRecordOf(client: CybionClient, threadId: string): Promise<number> {
  const history = await readHistory(client, threadId);
  return history.reduce((highest, record) => Math.max(highest, record.id), 0);
}

/**
 * The Thread this session runs in: the one to resume, checked to exist, or a
 * new empty one (`POST /v1/threads`). A resumed Thread keeps the model and
 * effort Cybion stored, and the Agent API has no route that changes them, so a
 * differing value is refused rather than silently ignored.
 */
export async function openThread(client: CybionClient, options: SessionOptions): Promise<CybionThread> {
  if (options.resume !== undefined) {
    const reply = await client.call("GET", `/v1/threads/${encodeURIComponent(options.resume)}`);
    if (reply.status === 404) {
      throw new SessionNotFoundError(options.resume, `Cybion has no Thread ${options.resume} to resume`, { method: "GET /v1/threads/{id}", native: { error: errorText(reply.body) } });
    }
    if (reply.status < 200 || reply.status >= 300) {
      throw new Error(`cybion GET /v1/threads/${options.resume} answered ${String(reply.status)}: ${replyMessage(reply)}`);
    }
    const resumed = threadOf(reply.body);
    if (options.model !== undefined && resumed.model !== null && options.model !== resumed.model) {
      throw new UnsupportedOptionError("model", `Cybion's Agent API has no route that changes a Thread's model, and Thread ${resumed.id} runs ${resumed.model}`);
    }
    if (options.effort !== undefined && resumed.effort !== null && options.effort !== resumed.effort) {
      throw new UnsupportedOptionError("effort", `Cybion's Agent API has no route that changes a Thread's reasoning effort, and Thread ${resumed.id} runs at ${resumed.effort}`);
    }
    return resumed;
  }
  const created = await client.call("POST", "/v1/threads", {
    ...(options.name === undefined ? {} : { title: options.name }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { reasoning_effort: options.effort }),
  });
  if (created.status < 200 || created.status >= 300) {
    const detail = errorText(created.body);
    throw new Error(`cybion POST /v1/threads answered ${String(created.status)}: ${detail ?? "no detail"}`);
  }
  const thread = threadOf(created.body);
  // A requested model is never silently substituted: the Thread reports the one
  // it runs, so a substitution fails the open instead of the first turn.
  if (options.model !== undefined && thread.model !== null && thread.model !== options.model) {
    throw new Error(`Cybion created Thread ${thread.id} with model ${thread.model}, not the requested ${options.model}`);
  }
  if (options.effort !== undefined && thread.effort !== null && thread.effort !== options.effort) {
    throw new Error(`Cybion created Thread ${thread.id} at reasoning effort ${thread.effort}, not the requested ${options.effort}`);
  }
  return thread;
}

/**
 * Hand one input to the Thread. Cybion refuses with a 4xx the adapter records
 * as a refusal, never as a delivered input: an empty or over-long input, more
 * images than it takes, or an image that is not a png/jpeg/webp/gif data URL.
 */
export async function submitInput(client: CybionClient, threadId: string, input: string, images: readonly string[]): Promise<unknown> {
  const reply = await client.call("POST", `/v1/threads/${encodeURIComponent(threadId)}/inputs`, {
    input,
    ...(images.length === 0 ? {} : { images: [...images] }),
  });
  if (reply.status < 200 || reply.status >= 300) {
    throw new CybionRefusalError(reply);
  }
  return reply.body;
}

/** The record Cybion says an accepted input occupies; null when it named none. */
export function acceptedRecordOf(answer: unknown): number | null {
  const index = asRecord(answer)?.record_idx;
  return asNumber(index);
}

/** The failure class a status names, for the ones Cybion makes plain. */
function failureOf(status: number): FailureClass | undefined {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return undefined;
}

/**
 * What one failed delivery attempt means to the caller, read from the status
 * Cybion answered: a rejected credential is an `auth` failure, a throttle a
 * `rate_limited` one, a 5xx a provider-side `error`. A transport failure keeps
 * the exception's own words and no class, because nothing answered.
 */
export function refusalOf(error: unknown): ResponseBody {
  if (!(error instanceof CybionRefusalError)) {
    return { kind: "rejected", code: "error", reason: String(error) };
  }
  if (error.status >= 500) {
    return { kind: "rejected", code: "error", reason: error.message, failure: "provider", native: error.native };
  }
  if (error.status === 404) {
    // The Thread the session was opened on is gone: no later control can succeed.
    return { kind: "rejected", code: "session_not_found", reason: error.message, native: error.native };
  }
  const failure = failureOf(error.status);
  return {
    kind: "rejected",
    code: error.refused ? "runtime_refused" : "error",
    reason: error.message,
    ...(failure === undefined ? {} : { failure }),
    native: error.native,
  };
}

/** Every `output_text` of one `response_output` message, in the item's own order. */
export function outputTextOf(payload: JsonRecord): string {
  return asRecordList(payload.content)
    .map((part) => (part.type === "output_text" ? text(part.text) ?? "" : ""))
    .join("");
}
