import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";
import type { FrameBody, TurnOutcome } from "../../contracts/session.js";
import { classifyFailure } from "../failure-class.js";
import { AcpError } from "./errors.js";

/*
 * Failures an ACP agent reports as JSON-RPC errors
 * (docs/spec/runtime-matrix.md#opencode-kimi-grok-antigravity-acp). ACP's
 * `RequestError.authRequired` is -32000: an `auth` failure that does not say
 * whether the login was missing or refused. An invalid-params answer (-32602)
 * to the call that selects the model refuses the model. Anything else is the
 * profile's to read (grok's own codes) or, as the last resort, its words.
 */

const AUTH_REQUIRED = -32_000;
const INVALID_PARAMS = -32_602;

/** The JSON-RPC error code an ACP request was answered with, if it was. */
export function rpcErrorCode(error: unknown): number | null {
  if (!(error instanceof Error) || error instanceof AcpError || !("code" in error)) {
    return null;
  }
  return typeof error.code === "number" ? error.code : null;
}

/** An open step's error, as `session()` rejects with it: a refused login or model becomes a `RuntimeFailureError`. */
export function acpOpenFailure(error: unknown, step: "open" | "model"): unknown {
  const code = rpcErrorCode(error);
  if (!(error instanceof Error) || code === null) {
    return error;
  }
  if (code === AUTH_REQUIRED) {
    return new RuntimeFailureError("auth", error.message, { cause: error });
  }
  if (step === "model" && code === INVALID_PARAMS) {
    return new RuntimeFailureError("model_unavailable", error.message, { cause: error });
  }
  return error;
}

/** `step` rejecting as `session()` does: through `acpOpenFailure`. */
export async function acpOpenStep<T>(step: Promise<T>, kind: "open" | "model"): Promise<T> {
  try {
    return await step;
  } catch (error) {
    throw acpOpenFailure(error, kind);
  }
}

/** Reads a failed prompt the generic rules do not: grok's codes and its retry notifications. */
export type AcpFailureReader = (error: unknown, turnFrames: readonly FrameBody[]) => TurnOutcome | null;

/** An RPC error's words: its message, and its `data` when that is text (grok puts the provider's answer there). */
export function acpErrorReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "ACP prompt failed";
  }
  const data = "data" in error && typeof error.data === "string" && error.data.length > 0 ? error.data : null;
  return data === null ? error.message : `${error.message}: ${data}`;
}

/** The outcome a rejected prompt request reports (an RPC error answer). */
export function acpFailureOutcome(error: unknown, turnFrames: readonly FrameBody[] = [], reader?: AcpFailureReader): TurnOutcome {
  const reason = acpErrorReason(error);
  if (error instanceof AcpError && error.kind === "process_exited") {
    return { kind: "failed", reason, failure: "runtime_exited" };
  }
  if (rpcErrorCode(error) === AUTH_REQUIRED) {
    return { kind: "failed", reason, failure: "auth" };
  }
  return reader?.(error, turnFrames) ?? { kind: "failed", reason, failure: classifyFailure(reason) };
}
