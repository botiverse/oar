import type { RefusableSessionOption, RefusedSessionOptions } from "../contracts/runtime.js";
import type { SessionOptions } from "../contracts/session.js";
import { UnsupportedOptionError } from "../contracts/errors.js";

/** Whether `options` gives `key`: any value for a prompt, a non-empty map for `env`, a non-empty list for `mcpServers`, `disallowedTools` or `launchArgs`. */
export function sessionOptionGiven(options: SessionOptions, key: RefusableSessionOption): boolean {
  if (key === "env") {
    return options.env !== undefined && Object.keys(options.env).length > 0;
  }
  if (key === "mcpServers" || key === "disallowedTools" || key === "launchArgs") {
    return options[key] !== undefined && options[key].length > 0;
  }
  return options[key] !== undefined;
}

/** Reject an open that gives an option the runtime declares refused: an `UnsupportedOptionError` naming it, with the declared reason. */
export function refuseSessionOptions(refused: RefusedSessionOptions, options: SessionOptions): void {
  for (const key of ["systemPrompt", "appendSystemPrompt", "env", "mcpServers", "disallowedTools", "launchArgs"] as const) {
    const reason = refused[key];
    if (reason !== undefined && sessionOptionGiven(options, key)) {
      throw new UnsupportedOptionError(key, key === "disallowedTools" ? `${reason}: ${JSON.stringify(options.disallowedTools)}` : reason);
    }
  }
}
