import { asRecord } from "../../shared/json.js";

/** One HTTP answer from Cybion, whatever its status. */
export interface CybionReply {
  readonly status: number;
  readonly body: unknown;
}

/** The message a Cybion answer carries: its `error` field, or the status alone. */
export function replyMessage(reply: CybionReply): string {
  const error = asRecord(reply.body)?.error;
  return typeof error === "string" && error !== "" ? error : `HTTP ${String(reply.status)}`;
}

/**
 * An input Cybion itself refused (a 4xx) rather than a transport failure:
 * `refused` separates "the runtime said no" from "the call did not arrive".
 */
export class CybionRefusalError extends Error {
  override readonly name = "CybionRefusalError";
  readonly native: unknown;
  readonly refused: boolean;
  readonly status: number;

  constructor(reply: CybionReply) {
    super(replyMessage(reply));
    this.native = reply.body;
    this.refused = reply.status >= 400 && reply.status < 500;
    this.status = reply.status;
  }
}
