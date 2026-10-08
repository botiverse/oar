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
