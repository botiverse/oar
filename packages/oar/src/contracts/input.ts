/** An image file handed to the runtime with an input (`InputOptions.images`). */
export interface InputImage {
  /** Absolute path on the machine the runtime runs on. */
  readonly path: string;
  /** `image/png`, `image/jpeg`, `image/gif` or `image/webp`; read from the file's extension when omitted. */
  readonly mediaType?: string;
}
