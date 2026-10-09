import type { TokenTotals } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { addTokens, cacheParts, noTokens, subtractTokens } from "../../shared/token-totals.js";

/*
 * claude's token readings: the root agent's main loop (`result.usage`) and
 * the session total, read off `result.modelUsage` (#282). claude's own
 * schema (2.1.289) calls `result.usage` "MAIN AGENT LOOP ONLY — excludes Task
 * subagent, sidechain, and auxiliary model calls" and `modelUsage` the
 * per-model totals of "every model call made through the query pipeline …
 * main loop, Task subagents, sidechains, and internal calls such as
 * compaction", cumulative across turns: each result carries the running
 * total, so the latest is read, never summed. Recorded on 2.1.292
 * (tests/replay/fixtures/claude-usage-*.raw.jsonl): a Task subagent and a
 * manual /compact grow `modelUsage` and leave `result.usage` alone.
 *
 * The total counts from when this Session opened. A new session's running
 * total starts at zero. A resumed one continues the previous process's
 * ([env] 2.1.292: the resumed process's first result carried the earlier
 * turns too), so before the first turn the adapter asks claude `get_usage`,
 * whose `session.model_usage` is that running total, and every later total
 * is less that baseline, model by model, as codex's is less its re-report
 * (token-usage.ts there). Without a baseline the share is unknown: don't
 * know, don't report.
 */

/**
 * `previous` plus one result's main-loop tokens (`result.usage`, per turn),
 * or null when the frame carries no usage. `input_tokens` excludes the cache
 * reads and writes, so input counts them back in; each also stands as its
 * own part when the frame reports it.
 */
export function withMainLoop(previous: TokenTotals | undefined, message: JsonRecord): TokenTotals | null {
  const usage = asRecord(message.usage);
  if (usage === null) {
    return null;
  }
  const cache = cacheParts(usage, { read: "cache_read_input_tokens", write: "cache_creation_input_tokens" });
  return addTokens(previous ?? noTokens, {
    input: (asNumber(usage.input_tokens) ?? 0) + (cache.cacheRead ?? 0) + (cache.cacheWrite ?? 0),
    output: asNumber(usage.output_tokens) ?? 0,
    ...cache,
  });
}

/** claude's running totals, by model. */
export type ModelTotals = ReadonlyMap<string, TokenTotals>;

/** Where this Session's share of claude's running total starts. */
export type ClaudeUsageBaseline =
  /** A resume whose `get_usage` answer has not come yet. */
  | { readonly kind: "awaiting" }
  | { readonly kind: "known"; readonly models: ModelTotals }
  /** A resume whose `get_usage` timed out, failed or carried no session totals. */
  | { readonly kind: "unknown" };

export interface ClaudeModelUsage {
  readonly baseline: ClaudeUsageBaseline;
  /** The running total claude last reported (the baseline before any): a lower one is a reset. */
  readonly last: ModelTotals;
  /** This Session's share counted before claude last reset its running total (a /clear). */
  readonly carried: TokenTotals;
}

const none: ModelTotals = new Map();

/** A new session: claude's running total and this Session's share both start at zero. */
export const freshModelUsage: ClaudeModelUsage = { baseline: { kind: "known", models: none }, last: none, carried: noTokens };

/** A resume: nothing is counted until the baseline is known. */
export const resumedModelUsage: ClaudeModelUsage = { ...freshModelUsage, baseline: { kind: "awaiting" } };

/**
 * One model's entry: `inputTokens` excludes the cache reads and writes (as
 * `result.usage.input_tokens` does), so input counts them back in, and each
 * stands as its own part. Null when the entry lacks a count.
 */
function modelTokens(entry: JsonRecord): TokenTotals | null {
  const input = asNumber(entry.inputTokens);
  const output = asNumber(entry.outputTokens);
  if (input === null || output === null) {
    return null;
  }
  const cache = cacheParts(entry, { read: "cacheReadInputTokens", write: "cacheCreationInputTokens" });
  return { input: input + (cache.cacheRead ?? 0) + (cache.cacheWrite ?? 0), output, ...cache };
}

/** A `modelUsage` (or `get_usage` `model_usage`) map read per model; null when it is not one or an entry lacks its counts. */
export function modelTotals(value: unknown): ModelTotals | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const models = new Map<string, TokenTotals>();
  for (const [model, raw] of Object.entries(record)) {
    const entry = asRecord(raw);
    const tokens = entry === null ? null : modelTokens(entry);
    if (tokens === null) {
      return null;
    }
    models.set(model, tokens);
  }
  return models;
}

/**
 * The baseline a `get_usage` control_response sets: its
 * `response.session.model_usage` (`{}` for a session with nothing saved).
 * Anything else (an error answer, a timeout or exit, a reply without session
 * totals) leaves it unknown.
 */
export function claudeUsageBaseline(answer: JsonRecord | Error): ClaudeUsageBaseline {
  const response = answer instanceof Error ? null : asRecord(answer.response);
  const session = response?.subtype === "success" ? asRecord(asRecord(response.response)?.session) : null;
  const models = session === null ? null : modelTotals(session.model_usage);
  return models === null ? { kind: "unknown" } : { kind: "known", models };
}

export function withBaseline(usage: ClaudeModelUsage, baseline: ClaudeUsageBaseline): ClaudeModelUsage {
  return { ...usage, baseline, last: baseline.kind === "known" ? baseline.models : usage.last };
}

/** What `models` holds beyond `baseline`, summed over models. */
function shareOf(models: ModelTotals, baseline: ModelTotals): TokenTotals {
  let share = noTokens;
  for (const [model, tokens] of models) {
    const start = baseline.get(model);
    share = addTokens(share, start === undefined ? tokens : subtractTokens(tokens, start));
  }
  return share;
}

/** A running total below the last one: claude reset it (a mid-session /clear). */
function wentBack(models: ModelTotals, last: ModelTotals): boolean {
  return [...last].some(([model, before]) => {
    const now = models.get(model);
    return now === undefined || now.input < before.input || now.output < before.output;
  });
}

/**
 * Fold one result's `modelUsage`: this Session's total so far, or null when
 * it is not known (a resume without a baseline) or the frame says nothing
 * (no `modelUsage`, or the zeroed one of a crash or startup-error result,
 * which must not move the total back). A total below the last one is claude
 * resetting its running total (its schema: "a mid-session /clear resets the
 * running total"): the share counted so far is kept and counting restarts
 * from zero.
 */
export function foldModelUsage(usage: ClaudeModelUsage, message: JsonRecord): { readonly usage: ClaudeModelUsage; readonly total: TokenTotals | null } {
  const models = modelTotals(message.modelUsage);
  if (usage.baseline.kind !== "known" || models === null) {
    return { usage, total: null };
  }
  const reported = shareOf(models, none);
  if (reported.input === 0 && reported.output === 0) {
    return { usage, total: null };
  }
  const reset = wentBack(models, usage.last);
  const baseline = reset ? none : usage.baseline.models;
  const carried = reset ? addTokens(usage.carried, shareOf(usage.last, usage.baseline.models)) : usage.carried;
  return {
    usage: { baseline: { kind: "known", models: baseline }, last: models, carried },
    total: addTokens(carried, shareOf(models, baseline)),
  };
}
