/* oxlint-disable import/prefer-default-export -- Private named protocol ownership error. */
/** A native response violates the connection's protocol ownership contract. */
export class AcpProtocolError extends Error {
  override readonly name = "AcpProtocolError";
}
