import { acpErrorReason, rpcErrorCode, type AcpFailureReader } from "../../shared/acp/failure.js";
import type { FailureClass } from "../../contracts/session.js";
import { asRecord } from "../../shared/json.js";

/*
 * A prompt opencode answered with an error is a JSON-RPC -32603 whose `data`
 * is `{ service, errorName }`; `errorName` is opencode's own `SessionError`
 * type (read on v2.2.6: packages/cli/src/acp/error.ts, packages/core/src/session/to-session-error.ts).
 * Only that field is read, and only a name in the table decides: any other
 * answer (no name, or one like `APIError`) is left to the generic rules, which
 * read its words. The status, retry delay and body do not reach ACP, and
 * nothing says whose quota a limit is, so no scope is reported.
 */

const INTERNAL_ERROR = -32_603;

const ERROR_NAMES: Readonly<Partial<Record<string, FailureClass>>> = {
  "provider.free-limit": "quota",
  "provider.go-limit": "quota",
  "provider.budget-limit": "quota",
  "provider.model-budget-limit": "quota",
  "provider.quota": "quota",
  "provider.rate-limit": "rate_limited",
};

export const opencodeFailureOutcome: AcpFailureReader = (error) => {
  if (rpcErrorCode(error) !== INTERNAL_ERROR) { return null; }
  const errorName = asRecord(error instanceof Error && "data" in error ? error.data : undefined)?.errorName;
  const failure = typeof errorName === "string" ? ERROR_NAMES[errorName] : undefined;
  return failure === undefined ? null : { kind: "failed", reason: acpErrorReason(error), failure };
};
