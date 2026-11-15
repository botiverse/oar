/* oxlint-disable import/prefer-default-export -- The package exports names only. */
/**
 * Opening a session could not confirm the requested model from native readback.
 * This is not evidence that the model is unavailable. The message keeps the
 * adapter's explanation; a failed catalog read may also retain its cause.
 * No turn exists yet: this is not a FailureClass.
 * See docs/spec/runtime-matrix.md#model-confirmation-failures.
 */
export class ModelConfirmationError extends Error {
  override readonly name = "ModelConfirmationError";
  /** The caller's model selector, without resolving it to a display name. */
  readonly requested: string;
  /** The runtime's reported model, or null when it supplied no model string. */
  readonly reported: string | null;
  /**
   * Selectors from the last catalog successfully read for this confirmation.
   * Absent if no catalog was read; [] means one was read with no selectors.
   * These are observations, not a guarantee that any selector will work.
   */
  declare readonly catalogSelectorIds?: readonly string[];

  constructor(message: string, details: {
    readonly requested: string;
    readonly reported: string | null;
    readonly catalogSelectorIds?: readonly string[];
    readonly cause?: unknown;
  }) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.requested = details.requested;
    this.reported = details.reported;
    if (details.catalogSelectorIds !== undefined) { this.catalogSelectorIds = [...details.catalogSelectorIds]; }
  }
}
