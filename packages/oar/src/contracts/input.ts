/** An image file handed to the runtime with an input (`InputOptions.images`). */
export interface InputImage {
  /** Absolute path on the machine the runtime runs on. */
  readonly path: string;
  /** `image/png`, `image/jpeg`, `image/gif` or `image/webp`; read from the file's extension when omitted. */
  readonly mediaType?: string;
}

/**
 * Who an input comes from, as the host says it. Recorded on the request
 * record (OAR's own evidence) and read back by the conversation projection;
 * never sent to the runtime. Lets a UI show input a person typed apart from
 * input the host injected.
 */
export interface InputOrigin {
  /**
   * `user`: a person typed it. `notification`: the host reports an event to
   * the agent (a subagent's result, a finished job, a message from elsewhere).
   * `automation`: the host's own scripted input.
   */
  readonly kind: "user" | "notification" | "automation";
  /** What produced it, in the host's words (`subagent:reviewer`, `ci`). */
  readonly source?: string;
}
