import type {
  ContextUsage,
  CredentialProblem,
  FailedTurn,
  FailureClass,
  RuntimeEventBody,
  TokenTotals,
} from "../../contracts/session.js";
import { failureFromStatus } from "../../shared/failure-class.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { addTokens, noTokens } from "../../shared/token-totals.js";
import { asString, type KapProjectionState } from "./kap-projection-state.js";

function classifyKapErrorCode(
  code: string | undefined,
  endReason: string | undefined,
  statusCode: number | null,
): FailureClass {
  if (code === "provider.auth_error") { return "auth"; }
  if (code === "provider.rate_limit") { return "rate_limited"; }
  if (code === "provider.overloaded") { return "overloaded"; }
  if (code === "provider.filtered" || endReason === "filtered" || endReason === "blocked") {
    return "model_refused";
  }
  if (code === "context.overflow") { return "input_too_large"; }
  if (code === "model.not_configured" || code === "model.config_invalid") {
    return "model_unavailable";
  }
  if (code === "loop.max_steps_exceeded" || endReason === "max_steps") {
    return "limit_reached";
  }
  if (code === "provider.connection_error") { return "provider"; }
  if (statusCode !== null) {
    const fromStatus = failureFromStatus(statusCode);
    if (fromStatus !== "unknown") { return fromStatus; }
  }
  if (code === "provider.api_error") { return "provider"; }
  return "unknown";
}

export function kapFailedTurn(endReason: string | undefined, error: unknown): FailedTurn {
  const rec = asRecord(error);
  const code = rec === null ? undefined : asString(rec.code);
  const message = rec === null ? undefined : asString(rec.message);
  const statusCode = rec === null ? null : asNumber(rec.status_code);
  const reason = message ?? (code ?? (endReason !== undefined ? `Turn ended (${endReason})` : "Kimi turn failed"));
  const status = statusCode ?? undefined;
  const failure = classifyKapErrorCode(code, endReason, statusCode);
  if (failure === "auth") {
    const credential: CredentialProblem | undefined = status === 401 ? "rejected" : undefined;
    return {
      kind: "failed",
      failure: "auth",
      reason,
      ...(status === undefined ? {} : { status }),
      ...(credential === undefined ? {} : { credential }),
    };
  }
  if (failure === "quota") {
    return {
      kind: "failed",
      failure: "quota",
      reason,
      ...(status === undefined ? {} : { status }),
    };
  }
  return {
    kind: "failed",
    failure,
    reason,
    ...(status === undefined ? {} : { status }),
  };
}

export function parseKapUsage(raw: unknown): TokenTotals | undefined {
  const rec = asRecord(raw);
  if (rec === null) { return undefined; }
  const inputOther = asNumber(rec.input_other);
  const output = asNumber(rec.output);
  if (inputOther === null && output === null && rec.input_cache_read === undefined && rec.input_cache_creation === undefined) {
    return undefined;
  }
  const cacheRead = asNumber(rec.input_cache_read);
  const cacheWrite = asNumber(rec.input_cache_creation);
  const input = (inputOther ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    input,
    output: output ?? 0,
    ...(cacheRead === null ? {} : { cacheRead }),
    ...(cacheWrite === null ? {} : { cacheWrite }),
  };
}

export function diffNonNegativeTokens(target: TokenTotals, base: TokenTotals): TokenTotals {
  const cacheRead = target.cacheRead === undefined
    ? undefined
    : Math.max(0, target.cacheRead - (base.cacheRead ?? 0));
  const cacheWrite = target.cacheWrite === undefined
    ? undefined
    : Math.max(0, target.cacheWrite - (base.cacheWrite ?? 0));
  return {
    input: Math.max(0, target.input - base.input),
    output: Math.max(0, target.output - base.output),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function hasPositiveTokens(tokens: TokenTotals): boolean {
  return tokens.input > 0 || tokens.output > 0 || (tokens.cacheRead ?? 0) > 0 || (tokens.cacheWrite ?? 0) > 0;
}

export function sumStepUsages(steps: ReadonlyMap<number, TokenTotals> | undefined): TokenTotals {
  let total = noTokens;
  if (steps === undefined) { return total; }
  for (const stepUsage of steps.values()) {
    total = addTokens(total, stepUsage);
  }
  return total;
}

export function addAgentUsageDelta(
  state: KapProjectionState,
  agentId: string,
  delta: TokenTotals,
): TokenTotals | undefined {
  if (!hasPositiveTokens(delta)) { return undefined; }
  const prev = state.cumulativeTokensByAgent.get(agentId) ?? noTokens;
  const next = addTokens(prev, delta);
  state.cumulativeTokensByAgent.set(agentId, next);
  return next;
}

export function projectContextUsage(rawFrame: JsonRecord, events: RuntimeEventBody[]): void {
  const contextTokens = asNumber(rawFrame.context_tokens);
  if (contextTokens === null) { return; }
  const maxTokens = asNumber(rawFrame.max_context_tokens);
  const percent = maxTokens !== null && maxTokens > 0
    ? Math.min(100, (contextTokens / maxTokens) * 100)
    : null;
  const context: ContextUsage = { tokens: contextTokens, contextWindow: maxTokens, percent };
  events.push({ kind: "usage", usage: { context } });
}

export function projectStepUsage(
  state: KapProjectionState,
  agentId: string,
  turnId: string,
  step: JsonRecord,
  events: RuntimeEventBody[],
): void {
  const stepIndex = asNumber(step.index);
  const stepUsage = parseKapUsage(step.usage);
  if (stepIndex === null || stepUsage === undefined) { return; }
  let steps = state.stepUsageByTurn.get(turnId);
  if (steps === undefined) {
    steps = new Map();
    state.stepUsageByTurn.set(turnId, steps);
  }
  const prevStep = steps.get(stepIndex) ?? noTokens;
  steps.set(stepIndex, stepUsage);
  const cumulative = addAgentUsageDelta(state, agentId, diffNonNegativeTokens(stepUsage, prevStep));
  if (cumulative !== undefined) {
    events.push({ kind: "usage", usage: { tokens: cumulative } });
  }
}

export function projectRetryUpdate(retry: JsonRecord, events: RuntimeEventBody[]): void {
  const attempt = asNumber(retry.attempt);
  if (attempt === null) { return; }
  const maxAttempts = asNumber(retry.max_attempts);
  const delayMs = asNumber(retry.delay_ms);
  const retryErr = asRecord(retry.error);
  const reason = retryErr === null ? undefined : asString(retryErr.message);
  events.push({
    kind: "retry",
    attempt,
    ...(maxAttempts === null ? {} : { maxAttempts }),
    ...(delayMs === null ? {} : { delayMs }),
    ...(reason === undefined ? {} : { reason }),
  });
}
