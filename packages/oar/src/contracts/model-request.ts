/** One attributed request built by the root agent's main loop in the current open. */
export interface ModelRequest {
  /** Approximate build time, reported in UTC. */
  readonly at: string;
  /** Provider request schema, for example `anthropic.messages`. */
  readonly format: string;
  /** The native request body after session credential redaction. Transport headers are never included. */
  readonly body?: unknown;
  /** Content the runtime withheld, or a body it did not capture. */
  readonly withheld?: readonly string[];
  readonly provider?: string;
  readonly model?: string;
}
