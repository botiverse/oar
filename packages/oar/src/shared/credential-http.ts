import { asRecord } from "./json.js";

/**
 * A credential about to become an HTTP header value. Checked before any
 * request: fetch refuses a value with a control character or space with an
 * error that quotes the whole header, credential included, so an invalid one
 * must fail here with a message that names only `what`.
 */
export function credentialHeaderValue(value: string, what: string): string {
  if (!/^[\u0021-\u007E]+$/u.test(value)) { throw new Error(`${what} is not a valid HTTP header value`); }
  return value;
}

/**
 * A request that failed before any answer, without the failure as its cause:
 * fetch's errors can quote request header values. Keeps only the system code
 * (`ECONNREFUSED`, ...) or that it timed out.
 */
export function requestFailure(what: string, error: unknown): Error {
  const code = asRecord(asRecord(error)?.cause)?.code ?? asRecord(error)?.code;
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const detail = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(code) ? ` (${code})` : (timedOut ? " (timed out)" : "");
  return new Error(`${what}${detail}`);
}
