import type { FailureClass } from "../contracts/session.js";

/**
 * Best-effort classification of vendor error prose. The patterns are pinned
 * by the vendor snapshot tests — when a runtime changes its wording, the
 * snapshot moves and this table gets a conscious update.
 */
export function classifyFailure(reason: string): FailureClass {
  if (/\b401\b|authentication|unauthorized|invalid (?:x-)?api[- ]?key|log(?:ged)? ?in/iu.test(reason)) {
    return "auth";
  }
  if (/\b429\b|rate.?limit|quota|usage limit/iu.test(reason)) {
    return "quota";
  }
  if (/\b400\b|invalid_request/iu.test(reason)) {
    return "invalid_request";
  }
  if (/\b529\b|\b503\b|overloaded/iu.test(reason)) {
    return "overloaded";
  }
  if (/\b\d{3}\b|error/iu.test(reason)) {
    return "provider";
  }
  return "unknown";
}
