import { SessionNotFoundError } from "../../contracts/session-not-found-error.js";
import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";

/*
 * An open `@cursor/sdk` refused (docs/spec/runtime-matrix.md#failure-evidence):
 * - [env] `@cursor/sdk` 1.0.36 `AuthenticationError` (status 401, made-up key): `auth` (`rejected`)
 * - [src] `@cursor/sdk` `errors.d.ts` `agent_not_found`: `SessionNotFoundError`
 * With no key, open succeeds and the first run fails via `cursor/projection.ts` (`[env]` prose fallback).
 */
export function cursorOpenFailure(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "AuthenticationError") {
    return error;
  }
  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  return new RuntimeFailureError("auth", error.message, { credential: "rejected", ...(status === undefined ? {} : { status }), cause: error });
}

/** Only the SDK's structural agent-not-found code, never an arbitrary failed open. */
export function cursorResumeFailure(error: unknown, sessionId: string, method: "Agent.listRuns" | "Agent.resume"): unknown {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "agent_not_found") { return error; }
  // SDK Error instances are not JSON-safe. Keep its observed diagnostic fields,
  // not the original Error/cause graph or arbitrary SDK internals.
  const native = {
    name: error.name,
    message: error.message,
    code: error.code,
    ...("operation" in error && typeof error.operation === "string" ? { operation: error.operation } : {}),
    ...("isRetryable" in error && typeof error.isRetryable === "boolean" ? { isRetryable: error.isRetryable } : {}),
  };
  return new SessionNotFoundError(sessionId, error.message, { method, native });
}
