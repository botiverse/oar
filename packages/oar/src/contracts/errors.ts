/* oxlint-disable import/prefer-default-export -- the package exports names only. */
import type { SessionOptions } from "./session.js";

/**
 * What `session()` rejects with when it is given an option the runtime cannot
 * honor: the open fails, never a session that quietly runs without the
 * option. `option` names it, so a host tells "not this runtime" from a failed
 * login or a network error without reading the message; the message is the
 * runtime's reason. A host that must decide before opening reads the same
 * facts from `Runtime.refusedSessionOptions`
 * (docs/spec/runtime-matrix.md#refused-session-options).
 */
export class UnsupportedOptionError extends Error {
  override readonly name = "UnsupportedOptionError";
  readonly option: keyof SessionOptions;

  constructor(option: keyof SessionOptions, message: string) {
    super(message);
    this.option = option;
  }
}
