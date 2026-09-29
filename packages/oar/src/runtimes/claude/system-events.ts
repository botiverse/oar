import type { RuntimeEventBody } from "../../contracts/session.js";
import { asNumber, type JsonRecord } from "../../shared/json.js";

/**
 * Events read out of the claude `system/*` frames that report a model swap,
 * a warning or a retry ([sym] 2.1.280, SDK 0.3.280 `sdk.d.ts`). `content` is
 * claude's own banner prose, the same line its TUI prints.
 *
 * - `model_fallback` (@internal in the SDK, passed through by stream-json):
 *   the turn moved to `fallback_model` because `original_model` was
 *   overloaded, unavailable, or failed past retry (`trigger`).
 * - `model_refusal_fallback`: a refusal retried on `fallback_model`. With
 *   `scope: "session"` (or absent, older CLIs) claude swaps the session
 *   model, so the frame is also a `model` report; `"local"` swaps only that
 *   subagent/side-question response.
 * - `model_refusal_no_fallback`, `model_consent_fallback`, and
 *   `informational` at level `warning`: prose only.
 * - `api_retry`: a retryable API failure retried after `retry_delay_ms`.
 */
export function claudeSystemEvents(message: JsonRecord): RuntimeEventBody[] {
  const content = typeof message.content === "string" && message.content.length > 0 ? message.content : null;
  const warning: RuntimeEventBody[] = content === null ? [] : [{ kind: "warning", message: content }];
  switch (message.subtype) {
    case "model_fallback":
    case "model_consent_fallback":
    case "model_refusal_no_fallback":
      return warning;
    case "model_refusal_fallback":
      return message.scope !== "local" && typeof message.fallback_model === "string"
        ? [...warning, { kind: "model", model: message.fallback_model }]
        : warning;
    case "informational":
      return message.level === "warning" ? warning : [];
    case "api_retry": {
      const attempt = asNumber(message.attempt);
      if (attempt === null) {
        return [];
      }
      const maxAttempts = asNumber(message.max_retries);
      const delayMs = asNumber(message.retry_delay_ms);
      return [{
        kind: "retry",
        attempt,
        ...(maxAttempts === null ? {} : { maxAttempts }),
        ...(delayMs === null ? {} : { delayMs }),
        ...(typeof message.error === "string" ? { reason: message.error } : {}),
      }];
    }
    default:
      return [];
  }
}
