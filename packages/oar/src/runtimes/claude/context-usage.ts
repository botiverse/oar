import type { CacheWriteByTtl, ContextUsage } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";

/**
 * Claude's context fullness, from the stream (structured; no need for the
 * human-facing /context command). What the context holds is what the root
 * agent's LATEST model call sent: its assistant frame's
 * `usage.{input,cache_read,cache_creation}_tokens`, claude's own status-line
 * reading (output is left out: the frame's `output_tokens` is the stream's
 * start, not the reply's). Not the `result` frame's `usage`: claude sums that
 * over every main-loop call of the turn, so a turn of N tool round trips
 * read about N times the context, past the window (recorded, 2.1.292: two
 * calls of 21,426 and 22,450 gave 43,876; its `usage.iterations` keeps the
 * last call alone). The window is `result.modelUsage[model].contextWindow`
 * for the latest call's model (the first entry when claude keys it
 * otherwise): modelUsage lists every model the session used, subagents' and
 * auxiliary ones included. The same latest root assistant frame also supplies
 * `cacheWriteByTtl` from `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`.
 * Folded per frame, read at the turn's result.
 */
export type ClaudeContextReading =
  /** No root model call and no compaction since the last result: the result reports no context, the previous reading stands. */
  | { readonly kind: "unchanged"; readonly model: string | null }
  /** The root agent's latest model call sent `tokens` and optional TTL-split cache writes. */
  | { readonly kind: "sent"; readonly tokens: number; readonly model: string | null; readonly cacheWriteByTtl?: CacheWriteByTtl }
  /** claude compacted the context after the latest call: unknown until the next one (the `ContextUsage` contract's null). */
  | { readonly kind: "compacted"; readonly model: string | null };

export const initialClaudeContext: ClaudeContextReading = { kind: "unchanged", model: null };

/** claude's model for the messages it makes up itself (an interrupted or errored turn's reply): no model call. */
const SYNTHETIC_MODEL = "<synthetic>";

function cacheWriteByTtlOf(usage: JsonRecord): CacheWriteByTtl | undefined {
  const creation = asRecord(usage.cache_creation);
  if (creation === null) { return undefined; }
  const fiveMin = asNumber(creation.ephemeral_5m_input_tokens);
  const oneHour = asNumber(creation.ephemeral_1h_input_tokens);
  if (fiveMin === null && oneHour === null) { return undefined; }
  return {
    ...(fiveMin === null ? {} : { "5m": fiveMin }),
    ...(oneHour === null ? {} : { "1h": oneHour }),
  };
}

/** A root `assistant` frame: the context its model call sent. Every frame of one message repeats the same usage. */
export function claudeContextSent(reading: ClaudeContextReading, message: JsonRecord): ClaudeContextReading {
  const body = asRecord(message.message);
  const usage = asRecord(body?.usage);
  const model = typeof body?.model === "string" ? body.model : null;
  if (usage === null || model === SYNTHETIC_MODEL) {
    return reading;
  }
  const tokens = (asNumber(usage.input_tokens) ?? 0) + (asNumber(usage.cache_read_input_tokens) ?? 0) + (asNumber(usage.cache_creation_input_tokens) ?? 0);
  const cacheWriteByTtl = cacheWriteByTtlOf(usage);
  return { kind: "sent", tokens, model: model ?? reading.model, ...(cacheWriteByTtl === undefined ? {} : { cacheWriteByTtl }) };
}

/** A root `compact_boundary`: what the context holds is unknown until claude's next call. */
export function claudeContextCompacted(reading: ClaudeContextReading): ClaudeContextReading {
  return { kind: "compacted", model: reading.model };
}

function windowOf(result: JsonRecord, model: string | null): number | null {
  const modelUsage = asRecord(result.modelUsage);
  if (modelUsage === null) {
    return null;
  }
  const entry = asRecord((model === null ? undefined : modelUsage[model]) ?? Object.values(modelUsage)[0]);
  return entry === null ? null : asNumber(entry.contextWindow);
}

/** A root `result`: the turn's context reading and last-call cache-write TTL split; the reading starts over for the next turn. */
export function claudeContextUsage(reading: ClaudeContextReading, result: JsonRecord): {
  readonly context: ContextUsage | null;
  readonly cacheWriteByTtl: CacheWriteByTtl | undefined;
  readonly reading: ClaudeContextReading;
} {
  const next: ClaudeContextReading = { kind: "unchanged", model: reading.model };
  if (reading.kind === "unchanged") {
    return { context: null, cacheWriteByTtl: undefined, reading: next };
  }
  const contextWindow = windowOf(result, reading.model);
  const tokens = reading.kind === "sent" ? reading.tokens : null;
  const percent = tokens === null || contextWindow === null || contextWindow === 0 ? null : Math.round((tokens / contextWindow) * 100);
  return {
    context: { tokens, contextWindow, percent },
    cacheWriteByTtl: reading.kind === "sent" ? reading.cacheWriteByTtl : undefined,
    reading: next,
  };
}
