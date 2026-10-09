import { SessionNotFoundError } from "../../contracts/session-not-found-error.js";
import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";

/*
 * An open `@cursor/sdk` refused (docs/spec/runtime-matrix.md#cursor). The SDK
 * checks the key with Cursor's service when an agent is created: a key it
 * refuses is an `AuthenticationError` with `status: 401` (observed on 1.0.36
 * with a made-up `CURSOR_API_KEY`). With no key at all the open succeeds and
 * the first run fails instead. The SDK's other errors are not observed and
 * stay as they are.
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
